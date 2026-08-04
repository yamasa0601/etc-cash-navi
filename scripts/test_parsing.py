"""パース処理のテスト。`python scripts/test_parsing.py` で実行。

ここを間違えると「出口は現金で降りられます」と嘘の案内をすることになるので、
特に scope_from_note は実データに出てくる表記を網羅しておく。
"""

from common import base_name, facility_kind, parse_jp_date, scope_from_note, split_name

SCOPE_CASES = [
    # (注記, 入口がETC専用か, 出口がETC専用か)
    ("", True, True),                                   # 注記なし = 全レーンETC専用
    ("入口のみ", True, False),
    ("出口のみ", False, True),
    ("出入口", True, True),                              # 「入口」の部分一致に注意
    ("出入り口", True, True),
    ("内回り大泉方面・入口", True, False),
    ("外回り高谷方面・入口", True, False),
    ("奈良方面への入口、奈良方面からの出口", True, True),
    ("東京方面出口", False, True),
    ("下り線", True, True),                              # 方向のみ = 判断材料なし
]

NAME_CASES = [
    ("戸田西(内回り大泉方面・入口)", "戸田西", "内回り大泉方面・入口"),
    ("山崎（中国自動車道）", "山崎", "中国自動車道"),
    ("東名川崎IC", "東名川崎IC", ""),
    ("瀬田西", "瀬田西", ""),
]

DATE_CASES = [
    ("令和4年4月1日", "2022-04-01"),
    ("R6.3.18", "2024-03-18"),
    ("R8.4.8", "2026-04-08"),
    ("平成30年3月1日", "2018-03-01"),
    ("2025/3/11", "2025-03-11"),
    ("未定", None),
]

BASE_CASES = [
    ("東名川崎IC", "東名川崎"),
    ("八王子西IC", "八王子西"),
    ("浜崎橋JCT", "浜崎橋"),
    ("瀬田西", "瀬田西"),
    # NEXCO 側と OSM 側で表記が割れる実例。どちらも同じキーになる必要がある
    ("千音寺南本線料金所 ※", "千音寺南"),
    ("千音寺南IC", "千音寺南"),
    ("増穂IC", "増穂"),
    ("増穂ＩＣ（下り；双葉方面）", "増穂"),       # 全角 IC + 括弧注記
    ("せと赤津IC", "せと赤津"),
    ("せと赤津IC/PA(内回り)", "せと赤津"),
    ("湾岸長島IC/PA(下り)", "湾岸長島"),
    ("鴨川西本線", "鴨川西"),
    ("鴨川西TB", "鴨川西"),
]

KIND_CASES = [
    ("鴨川西本線", "mainline"),
    ("千音寺南本線料金所", "mainline"),
    ("鴨川西TB", "mainline"),
    ("鴨川西", "ic"),
    ("東名川崎IC", "ic"),
]


def main() -> int:
    failures = []

    for note, want_in, want_out in SCOPE_CASES:
        got = scope_from_note(note)
        if (got["entrance"], got["exit"]) != (want_in, want_out):
            failures.append(f"scope_from_note({note!r}) -> {got}, want in={want_in} out={want_out}")

    for raw, want_name, want_note in NAME_CASES:
        got = split_name(raw)
        if got != (want_name, want_note):
            failures.append(f"split_name({raw!r}) -> {got}, want {(want_name, want_note)}")

    for raw, want in DATE_CASES:
        got = parse_jp_date(raw)
        if got != want:
            failures.append(f"parse_jp_date({raw!r}) -> {got!r}, want {want!r}")

    for raw, want in BASE_CASES:
        got = base_name(raw)
        if got != want:
            failures.append(f"base_name({raw!r}) -> {got!r}, want {want!r}")

    for raw, want in KIND_CASES:
        got = facility_kind(raw)
        if got != want:
            failures.append(f"facility_kind({raw!r}) -> {got!r}, want {want!r}")

    total = (len(SCOPE_CASES) + len(NAME_CASES) + len(DATE_CASES)
             + len(BASE_CASES) + len(KIND_CASES))
    if failures:
        print(f"FAILED {len(failures)}/{total}")
        for f in failures:
            print("  -", f)
        return 1
    print(f"OK  {total} cases passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
