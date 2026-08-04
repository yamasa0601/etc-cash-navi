"""NEXCO 3 社の ETC 専用料金所リストを取得して共通フォーマットに正規化する。

各社とも「機械可読な一覧」は公開していないため、公開ページ / PDF から抽出する。
出力レコード:
    operator  事業者名
    route     路線名 (例 "E1 名神高速道路")
    name      料金所・IC 名
    pref      都道府県
    note      備考 (方向・出入口の限定など)
    entrance  入口が ETC 専用か
    exit      出口が ETC 専用か
    since     運用開始日 (ISO)
    detour    現金で使える迂回先 (NEXCO 東日本のみ公開)
"""

from __future__ import annotations

import io
import re

import pdfplumber

from common import RAW, fetch, norm, parse_jp_date, scope_from_note, soup, split_name, table_to_grid

EAST_URL = "https://www.driveplaza.com/etc/etc_guide/etc_only_station/"
CENTRAL_URL = "https://dc2.c-nexco.co.jp/etc/service/dedicated_etc.html"
WEST_INDEX = "https://www.w-nexco.co.jp/etc/etc-only/"

PREF_RE = re.compile(
    r"(北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|"
    r"東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|"
    r"滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|"
    r"香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)"
)


def _record(operator, route, name, pref, note, since, detour=None) -> dict:
    clean, paren_note = split_name(name)
    note = " / ".join(p for p in (paren_note, norm(note)) if p)
    return {
        "operator": operator,
        "route": norm(route),
        "name": clean,
        "pref": pref or "",
        "note": note,
        **scope_from_note(note),
        "since": since,
        "detour": detour or [],
    }


def nexco_east(refresh: bool = False) -> list[dict]:
    """NEXCO 東日本。ETC 専用料金所の一覧表を読む。

    このページには「現金車の迂回先」対応表も書かれているが、HTML コメントで
    無効化されており現在は公開されていない。取り下げられた内容を正として
    案内するのは危険なので使わない。迂回先は build_dataset.py 側で、
    現金が使える最寄り IC を距離から求める。
    """
    page = soup(fetch(EAST_URL, "nexco_east.html", refresh=refresh))
    tables = page.find_all("table")
    if not tables:
        raise RuntimeError("NEXCO東日本: 表が見つからない。ページ構造が変わった可能性")

    out: list[dict] = []
    grid = table_to_grid(tables[0])
    header = "".join(grid[0]) if grid else ""
    if "料金所名" not in header:
        raise RuntimeError(f"NEXCO東日本: 想定外のヘッダ {header!r}")
    for row in grid[1:]:
        if len(row) < 4 or not row[1]:
            continue
        route, name, area, date = row[0], row[1], row[2], row[3]
        pref_m = PREF_RE.search(area)
        rec = _record(
            "NEXCO東日本", route, name,
            pref_m.group(1) if pref_m else "", "", parse_jp_date(date),
        )
        rec["city"] = norm(area)
        out.append(rec)
    return out


def nexco_central(refresh: bool = False) -> list[dict]:
    """NEXCO 中日本。都道府県 / 道路名 / 料金所名 の 3 列表。"""
    page = soup(fetch(CENTRAL_URL, "nexco_central.html", refresh=refresh))
    out: list[dict] = []
    for table in page.find_all("table"):
        grid = table_to_grid(table)
        if not grid or "料金所名" not in "".join(grid[0]):
            continue
        for row in grid[1:]:
            if len(row) < 3 or not row[2]:
                continue
            pref_m = PREF_RE.search(row[0])
            out.append(_record(
                "NEXCO中日本", row[1], row[2],
                pref_m.group(1) if pref_m else "", "", None,
            ))
    if not out:
        raise RuntimeError("NEXCO中日本: 抽出 0 件。ページ構造が変わった可能性")
    return out


def _west_pdf_url(refresh: bool = False) -> str:
    """一覧 PDF の URL は更新のたびに日付が変わるので、索引ページから拾う。"""
    html = fetch(WEST_INDEX, "nexco_west_index.html", refresh=refresh)
    m = re.search(r'href="([^"]*?/?pdfs/\d+\.pdf)"', html)
    if not m:
        raise RuntimeError("NEXCO西日本: 一覧 PDF のリンクが見つからない")
    href = m.group(1)
    if href.startswith("http"):
        return href
    return "https://www.w-nexco.co.jp/etc/etc-only/" + href.lstrip("./")


def nexco_west(refresh: bool = False) -> list[dict]:
    """NEXCO 西日本。PDF の表を pdfplumber で読む。"""
    url = _west_pdf_url(refresh=refresh)
    pdf_bytes = fetch(url, "nexco_west.pdf", binary=True, refresh=refresh)

    out: list[dict] = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables():
                for row in table:
                    cells = [norm(c or "") for c in row]
                    if len(cells) < 5 or cells[0] in ("エリア", ""):
                        continue
                    pref, route, name, date = cells[1], cells[2], cells[3], cells[4]
                    remark = cells[5] if len(cells) > 5 else ""
                    if not PREF_RE.fullmatch(pref) or not name:
                        continue
                    out.append(_record("NEXCO西日本", route, name, pref, remark, parse_jp_date(date)))
    if not out:
        raise RuntimeError("NEXCO西日本: 抽出 0 件。PDF の体裁が変わった可能性")
    return out


SOURCES = {"east": nexco_east, "central": nexco_central, "west": nexco_west}


if __name__ == "__main__":
    import sys

    for key, fn in SOURCES.items():
        try:
            rows = fn(refresh="--refresh" in sys.argv)
        except Exception as exc:  # noqa: BLE001 - 1 社落ちても他社は出したい
            print(f"[{key}] FAILED: {exc}")
            continue
        print(f"[{key}] {len(rows)} 件")
        for r in rows[:3]:
            print("   ", r)
    print(f"\nraw cache: {RAW}")
