"""OpenStreetMap から IC (分岐ノード) と料金所の位置を取得する。

Overpass はしばしば混雑して 504 やエラー HTML を返すため、ミラーを順に試して
リトライする。取得できたデータは data/raw に置き、build_dataset.py が読む。
"""

from __future__ import annotations

import json
import sys
import time

import requests

from common import RAW, UA

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.osm.jp/api/interpreter",
]

QUERIES = {
    # 高速道路の出入口・分岐。IC の位置はこれが一番素直に取れる。
    "osm_junctions.json": """
[out:json][timeout:300];
area["ISO3166-1"="JP"][admin_level=2]->.jp;
node["highway"="motorway_junction"](area.jp);
out body;
""",
    # 料金所。本線料金所の位置はこちらにしかない。
    "osm_tollbooths.json": """
[out:json][timeout:300];
area["ISO3166-1"="JP"][admin_level=2]->.jp;
(
  node["barrier"="toll_booth"](area.jp);
  way["barrier"="toll_booth"](area.jp);
);
out center;
""",
    # 高速道路の本線。各 IC がどの路線に属するかを ref (高速道路ナンバリング) から
    # 判定するために使う。NEXCO が一覧を出していない都市高速を、現金可と誤って
    # 扱わないために必要。out body はノード ID のみで座標を含まないため軽い。
    "osm_motorways.json": """
[out:json][timeout:600];
area["ISO3166-1"="JP"][admin_level=2]->.jp;
way["highway"="motorway"](area.jp);
out body;
""",
}


def run_query(query: str, attempts: int = 3) -> dict:
    last = ""
    for attempt in range(attempts):
        for url in ENDPOINTS:
            try:
                res = requests.post(url, data={"data": query},
                                    headers={"User-Agent": UA}, timeout=300)
            except requests.RequestException as exc:
                last = f"{url}: {exc}"
                continue
            text = res.text.lstrip()
            if res.status_code == 200 and text.startswith("{"):
                try:
                    return json.loads(text)
                except json.JSONDecodeError as exc:
                    last = f"{url}: JSON 不正 {exc}"
                    continue
            last = f"{url}: HTTP {res.status_code} {text[:120]!r}"
            print(f"    retry ({last})", file=sys.stderr)
        wait = 10 * (attempt + 1)
        print(f"    全ミラー失敗。{wait}s 待機", file=sys.stderr)
        time.sleep(wait)
    raise RuntimeError(f"Overpass 取得失敗: {last}")


def main() -> int:
    RAW.mkdir(parents=True, exist_ok=True)
    for filename, query in QUERIES.items():
        path = RAW / filename
        if path.exists() and "--refresh" not in sys.argv:
            print(f"{filename}: キャッシュ利用 (--refresh で再取得)")
            continue
        print(f"{filename}: 取得中…")
        data = run_query(query)
        elements = data.get("elements", [])
        if len(elements) < 100:
            raise RuntimeError(f"{filename}: 件数が少なすぎる ({len(elements)})。取得失敗の疑い")
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        print(f"  -> {len(elements)} 件")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
