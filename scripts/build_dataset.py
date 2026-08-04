"""ETC 専用料金所リストと OSM の位置情報を突き合わせて data/ic.json を作る。

考え方:
  - IC の位置は OSM の highway=motorway_junction から取る。
  - 本線料金所の位置は barrier=toll_booth から取る。IC とは別施設として扱う。
  - 「どこが ETC 専用か」は NEXCO 3 社の公開情報から取る (sources.py)。
  - 突き合わせは「都道府県 + 正規化した名前 + 施設種別」で行う。
  - スマート IC は制度上すべて ETC 専用なので名称から機械的に付与する。

出力の e フィールド:
    0 = 現金可
    1 = 入口のみ ETC 専用 (出口は現金可)
    2 = 出口のみ ETC 専用 (入口は現金可)
    3 = 入口・出口とも ETC 専用 / 本線料金所なら通過不可
"""

from __future__ import annotations

import datetime as _dt
import json
import math
import re
from collections import defaultdict

from shapely.geometry import Point, shape
from shapely.strtree import STRtree

from common import OUT, RAW, base_name, facility_kind, norm
from sources import SOURCES

# 同名 IC が別路線にも存在するため、この距離以内の同名ノードだけ同一施設とみなす
CLUSTER_KM = 5.0

JCT_RE = re.compile(r"(JCT|ジャンクション)")
SMART_RE = re.compile(r"(スマート|SIC|ｽﾏｰﾄ)")
# PA / SA は本線に接するだけで、一般道から乗り降りはできない (スマート IC 併設を除く)
PA_RE = re.compile(r"(PA|SA|パーキングエリア|サービスエリア)")
# 「◯◯出口」「◯◯入口」は都市高速に多い片方向のランプ
EXIT_ONLY_RE = re.compile(r"出口\s*$")
ENTRANCE_ONLY_RE = re.compile(r"入口\s*$")

# NEXCO 3 社が ETC 専用料金所の一覧を公開している路線だけを「判定できる範囲」とする。
# 高速道路ナンバリングの E 番号がこれにあたる。C3 (外環道) と C4 (圏央道) も NEXCO。
# 一方 C1 は名古屋高速・首都高の都心環状、数字のみは阪神高速などの都市高速で、
# 各社が別々に運用しているため今回のデータでは可否を判断できない。
NEXCO_REF_RE = re.compile(r"^E\d+[A-Z]?$")
NEXCO_RING_REFS = {"C3", "C4"}
# C2 は東京 (首都高中央環状) と愛知 (名二環) で別路線。名二環側だけ NEXCO。
C2_NEXCO_PREFS = {"愛知県", "三重県", "岐阜県"}


def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def _pref_lookup():
    geo = json.loads((RAW / "japan_pref.geojson").read_text(encoding="utf-8"))
    geoms = [shape(f["geometry"]) for f in geo["features"]]
    names = [f["properties"]["nam_ja"] for f in geo["features"]]
    tree = STRtree(geoms)

    def lookup(lon: float, lat: float) -> str:
        pt = Point(lon, lat)
        for idx in tree.query(pt):
            if geoms[idx].contains(pt):
                return names[idx]
        # 埋立地や海沿いの IC (台場・りんくうJCT など) は海岸線の簡略化で
        # ポリゴンから外れることがある。近い県に寄せる。
        idx = tree.nearest(pt)
        return names[idx] if geoms[idx].distance(pt) < 0.05 else ""

    return lookup


def _read_nodes(filename: str) -> list[dict]:
    """OSM 要素から (名前つき・座標つき) のものだけ取り出す。"""
    out = []
    for el in json.loads((RAW / filename).read_text(encoding="utf-8"))["elements"]:
        tags = el.get("tags") or {}
        name = tags.get("name") or tags.get("name:ja")
        if not name:
            continue
        lat, lon = el.get("lat"), el.get("lon")
        if lat is None and "center" in el:
            lat, lon = el["center"]["lat"], el["center"]["lon"]
        if lat is None:
            continue
        out.append({"id": el.get("id"), "name": norm(name), "lat": lat, "lon": lon})
    return out


def _node_routes() -> tuple[dict[int, set[str]], set[int], set[int]]:
    """本線のノード ID から、路線番号 (ref)・有料か・そもそも本線上にあるかを引く。

    「本線データに無い」ことは「無料」の根拠にならない。無料と言い切れるのは、
    本線上にあると確認できて、かつ有料の指定が無い場合だけ。
    """
    path = RAW / "osm_motorways.json"
    if not path.exists():
        return {}, set(), set()
    refs_by_node: dict[int, set[str]] = defaultdict(set)
    tolled: set[int] = set()
    known: set[int] = set()
    for way in json.loads(path.read_text(encoding="utf-8"))["elements"]:
        tags = way.get("tags") or {}
        nodes = way.get("nodes", [])
        known.update(nodes)
        ref = tags.get("ref")
        if ref:
            values = {r.strip() for r in ref.split(";") if r.strip()}
            for node_id in nodes:
                refs_by_node[node_id] |= values
        if tags.get("toll") == "yes":
            tolled.update(nodes)
    return refs_by_node, tolled, known


# 判定できる度合い。数字が大きいほど安心して案内できる。
COVER_UNKNOWN = 0   # 有料だが NEXCO 以外。可否のデータが無い
COVER_FREE = 1      # 無料区間。そもそも料金所が無いので現金で通れる
COVER_NEXCO = 2     # NEXCO の一覧で ETC 専用かどうか判断できる


def _coverage(refs: set[str], pref: str, is_tolled: bool, is_known: bool) -> int:
    """その施設の現金可否をどこまで言い切れるかを返す。

    判断できない路線 (都市高速など) を「現金可」と言い切るのが一番危ないので、
    確実に分かる場合だけ COVER_NEXCO / COVER_FREE を返す。
    """
    for ref in refs:
        if NEXCO_REF_RE.match(ref) or ref in NEXCO_RING_REFS:
            return COVER_NEXCO
        if ref == "C2" and pref in C2_NEXCO_PREFS:
            return COVER_NEXCO
    if is_known and not is_tolled:
        return COVER_FREE
    return COVER_UNKNOWN


def _kind_of(name: str) -> str:
    if JCT_RE.search(name):
        return "jct"
    # スマート IC 併設の PA は乗り降りできるが、そもそも ETC 専用なので IC 扱い不要
    if PA_RE.search(name) and not SMART_RE.search(name):
        return "pa"
    return "ic"


def _ramp_direction(name: str) -> int:
    """片方向ランプかどうか。0=両方向 / 1=入口のみ / 2=出口のみ。"""
    if ENTRANCE_ONLY_RE.search(name):
        return 1
    if EXIT_ONLY_RE.search(name):
        return 2
    return 0


def _cluster(nodes: list[dict], pref_of, kind_of, routes) -> list[dict]:
    """同一施設が複数ノードに分かれているので、県 + 名前 + 近接でまとめる。"""
    refs_by_node, tolled, known = routes
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for n in nodes:
        n["pref"] = pref_of(n["lon"], n["lat"])
        n["refs"] = refs_by_node.get(n.get("id"), set())
        n["tolled"] = n.get("id") in tolled
        n["known"] = n.get("id") in known
        groups[(n["pref"], base_name(n["name"]))].append(n)

    facilities = []
    for (pref, key), members in groups.items():
        clusters: list[list[dict]] = []
        for m in members:
            for c in clusters:
                if haversine_km((m["lat"], m["lon"]), (c[0]["lat"], c[0]["lon"])) <= CLUSTER_KM:
                    c.append(m)
                    break
            else:
                clusters.append([m])
        for c in clusters:
            display = max((m["name"] for m in c), key=len)
            refs: set[str] = set()
            for m in c:
                refs |= m["refs"]
            tolled = any(m["tolled"] for m in c)
            known = any(m["known"] for m in c)

            # 用賀のように東名と首都高が重なる場所では、同名ノードの重心が
            # 別の道路に載ってしまう。経路計算がそこへスナップすると往復の
            # 遠回りが生まれるので、NEXCO 路線上のノードを優先して代表点にする。
            on_nexco = [m for m in c if _coverage(m["refs"], pref, m["tolled"], m["known"]) == COVER_NEXCO]
            anchor = on_nexco or c

            facilities.append({
                "name": display, "key": key, "pref": pref,
                "lat": round(sum(m["lat"] for m in anchor) / len(anchor), 6),
                "lon": round(sum(m["lon"] for m in anchor) / len(anchor), 6),
                "kind": kind_of(display),
                "refs": sorted(refs),
                "covered": _coverage(refs, pref, tolled, known),
                "ramp": _ramp_direction(display),
                "etc": 0, "why": "",
            })
    return facilities


def load_facilities() -> list[dict]:
    pref_of = _pref_lookup()
    routes = _node_routes()

    junctions = _read_nodes("osm_junctions.json")
    ics = _cluster(junctions, pref_of, _kind_of, routes)

    # 料金所ノードは IC 併設のものが大半で、それらは分岐ノード側と重複する。
    # 分岐ノードでは取れない本線料金所だけを拾う。
    booths = [b for b in _read_nodes("osm_tollbooths.json")
              if facility_kind(b["name"]) == "mainline"]
    mainlines = _cluster(booths, pref_of, lambda _n: "mainline", routes)

    return ics + mainlines


def build(refresh: bool = False) -> dict:
    facilities = load_facilities()

    records, counts = [], {}
    for name, fn in SOURCES.items():
        rows = fn(refresh=refresh)
        counts[name] = len(rows)
        records.extend(rows)

    # 施設種別ごとに索引を作る。本線料金所と同名の IC を取り違えないため。
    index: dict[tuple[str, str, str], list[dict]] = defaultdict(list)
    loose: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for f in facilities:
        group = "mainline" if f["kind"] == "mainline" else "ic"
        index[(group, f["pref"], f["key"])].append(f)
        loose[(group, f["key"])].append(f)

    matched, unmatched = 0, []
    for rec in records:
        group = facility_kind(rec["name"])
        key = base_name(rec["name"])
        # 県名の表記ゆれや県境の施設を拾うため、県一致で引けなければ全国で引く
        cands = index.get((group, rec["pref"], key)) or loose.get((group, key)) or []
        approx = False
        if not cands and group == "mainline":
            # 本線料金所が OSM 未登録のことがある。ETC 専用の本線料金所を落とすと
            # 「通れない区間」を見落とすので、同名 IC の位置で近似してでも警告を出す。
            cands = index.get(("ic", rec["pref"], key)) or loose.get(("ic", key)) or []
            approx = bool(cands)
        if not cands:
            unmatched.append(rec)
            continue
        code = (1 if rec["entrance"] else 0) | (2 if rec["exit"] else 0)
        why = f"{rec['operator']} {rec['route']}"
        if rec["note"]:
            why += f"（{rec['note']}）"
        for f in cands:
            f["etc"] |= code
            f["why"] = why
            # NEXCO の一覧に載っている以上、ref が引けなくても判定対象である
            f["covered"] = COVER_NEXCO
            if approx:
                f["kind"] = "mainline"
                f["approx"] = True
                f["why"] += "【本線料金所・位置は近似】"
        matched += 1

    # スマート IC は制度上すべて ETC 専用。各社の一覧には載らないので名称から補う。
    smart = 0
    for f in facilities:
        if f["kind"] != "mainline" and SMART_RE.search(f["name"]) and f["etc"] != 3:
            f["etc"] = 3
            f["why"] = f["why"] or "スマートICはETC専用"
            smart += 1

    payload = {
        "generated_at": _dt.datetime.now(_dt.UTC).isoformat(timespec="seconds"),
        "counts": {
            "facilities": len(facilities),
            "etc_only": sum(1 for f in facilities if f["etc"]),
            "smart_ic": smart,
            "mainline_etc_only": sum(1 for f in facilities if f["kind"] == "mainline" and f["etc"]),
            "nexco": sum(1 for f in facilities if f["covered"] == COVER_NEXCO),
            "toll_free": sum(1 for f in facilities if f["covered"] == COVER_FREE),
            "unknown": sum(1 for f in facilities if f["covered"] == COVER_UNKNOWN),
            "usable_ic": sum(1 for f in facilities
                             if f["covered"] and f["kind"] == "ic" and not f["etc"]),
            "source_records": counts,
            "matched": matched,
            "unmatched": len(unmatched),
        },
        # c: 2 = NEXCOの一覧で判断できる / 1 = 無料区間で料金所なし / 0 = 判断できない
        # d: 0 = 出入口とも / 1 = 入口のみのランプ / 2 = 出口のみのランプ
        "ics": [
            {"n": f["name"], "p": f["pref"], "y": f["lat"], "x": f["lon"],
             "k": f["kind"], "e": f["etc"], "w": f["why"],
             "c": f["covered"], "d": f["ramp"],
             "r": ",".join(f["refs"][:3])}
            for f in sorted(facilities, key=lambda f: (f["pref"], f["name"]))
        ],
    }

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "ic.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT / "unmatched.json").write_text(
        json.dumps(unmatched, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


if __name__ == "__main__":
    import sys

    result = build(refresh="--refresh" in sys.argv)
    print(json.dumps(result["counts"], ensure_ascii=False, indent=2))
    print(f"\n-> {OUT / 'ic.json'}")
