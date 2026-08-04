"""スクレイパー共通のユーティリティ。"""

from __future__ import annotations

import datetime as _dt
import re
import unicodedata
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data"

UA = "Mozilla/5.0 (compatible; etc-cash-navi/0.1; data refresh bot)"


def fetch(url: str, cache_name: str, binary: bool = False, refresh: bool = False) -> bytes | str:
    """URL を取得する。data/raw に生データを残し、差分確認できるようにする。"""
    RAW.mkdir(parents=True, exist_ok=True)
    path = RAW / cache_name
    if path.exists() and not refresh:
        return path.read_bytes() if binary else path.read_text(encoding="utf-8")

    res = requests.get(url, headers={"User-Agent": UA}, timeout=60)
    res.raise_for_status()
    if binary:
        path.write_bytes(res.content)
        return res.content
    res.encoding = res.apparent_encoding or "utf-8"
    path.write_text(res.text, encoding="utf-8")
    return res.text


def soup(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, "lxml")


def table_to_grid(table) -> list[list[str]]:
    """rowspan / colspan を展開して矩形の二次元配列にする。

    NEXCO の表は路線名が rowspan でまとめられているため、素直にセルを読むと
    行ごとに列数がずれる。ここで埋めておく。
    """
    grid: list[list[str | None]] = []
    for r, tr in enumerate(table.find_all("tr")):
        while len(grid) <= r:
            grid.append([])
        col = 0
        for cell in tr.find_all(["td", "th"]):
            while col < len(grid[r]) and grid[r][col] is not None:
                col += 1
            text = norm(cell.get_text(" ", strip=True))
            rowspan = int(cell.get("rowspan", 1) or 1)
            colspan = int(cell.get("colspan", 1) or 1)
            for dr in range(rowspan):
                rr = r + dr
                while len(grid) <= rr:
                    grid.append([])
                for dc in range(colspan):
                    cc = col + dc
                    while len(grid[rr]) <= cc:
                        grid[rr].append(None)
                    grid[rr][cc] = text
            col += colspan
    width = max((len(row) for row in grid), default=0)
    return [[(c if c is not None else "") for c in row] + [""] * (width - len(row)) for row in grid]


def norm(s: str) -> str:
    """全角英数を半角に、空白を正規化する。IC 名の突き合わせに効く。"""
    s = unicodedata.normalize("NFKC", s or "")
    s = s.replace("　", " ")
    return re.sub(r"\s+", " ", s).strip()


_ERA = {"令和": 2018, "R": 2018, "平成": 1988, "H": 1988}


def parse_jp_date(s: str) -> str | None:
    """「令和4年4月1日」「R6.3.18」などを ISO 日付に変換する。"""
    s = norm(s)
    m = re.search(r"(令和|平成|R|H)\s*(\d+)\s*[年.\-/]\s*(\d+)\s*[月.\-/]\s*(\d+)", s)
    if m:
        era, y, mo, d = m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4))
        try:
            return _dt.date(_ERA[era] + y, mo, d).isoformat()
        except ValueError:
            return None
    m = re.search(r"(20\d{2})\s*[年.\-/]\s*(\d+)\s*[月.\-/]\s*(\d+)", s)
    if m:
        try:
            return _dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
        except ValueError:
            return None
    return None


# 「(内回り大泉方面・入口)」のように括弧内へ方向と出入口が入る表記を剥がす
_PAREN = re.compile(r"[(（]([^)）]*)[)）]\s*$")


def split_name(raw: str) -> tuple[str, str]:
    """料金所名から括弧の注記を分離して (名称, 注記) を返す。"""
    raw = norm(raw)
    note_parts: list[str] = []
    while (m := _PAREN.search(raw)) is not None:
        note_parts.insert(0, m.group(1).strip())
        raw = raw[: m.start()].strip()
    return raw, " / ".join(p for p in note_parts if p)


# NEXCO 側は「せと赤津IC」、OSM 側は「せと赤津IC/PA(内回り)」のように
# 同じ場所でも表記が揃わない。突き合わせ前に施設種別・方向・注記を全部落とす。
_FACILITY = r"(?:IC|SIC|JCT|JCT?I?|TB|PA|SA|BS|スマートIC|インターチェンジ|ジャンクション|本線料金所|料金所)"
_MARKERS = re.compile(r"[※*＊#♯]+")


def base_name(name: str) -> str:
    """突き合わせ用のキーを作る。施設種別・方向・括弧注記をすべて落とす。

    「本線」は残さない。本線料金所とインターチェンジは別施設なので、
    区別は呼び出し側が facility_kind() で行う。
    """
    n = _MARKERS.sub("", norm(name))
    n = split_name(n)[0]  # 末尾の括弧注記を除去
    n = re.sub(r"[/・]" + _FACILITY, "", n)  # 「IC/PA」「IC・PA」の後半
    n = re.sub(r"(?:" + _FACILITY + r")+\s*$", "", n).strip()
    n = re.sub(r"本線\s*$", "", n).strip()
    return n or norm(name)


def facility_kind(name: str) -> str:
    """本線料金所か、出入口 (IC) かを名前から判定する。

    本線料金所が ETC 専用になると、現金車はその区間自体を通れない。
    IC が使えないのとは影響の重さが違うので必ず分けて扱う。
    """
    n = norm(name)
    # 「鴨川西TB」のように漢字に直接続くため \b は使えない (漢字も \w 扱い)
    if "本線" in n or re.search(r"TB\s*$", n):
        return "mainline"
    return "ic"


def scope_from_note(note: str) -> dict:
    """注記から、入口・出口のどちらが ETC 専用になるかを判定する。

    片側だけと誤って判定すると「出口は現金で降りられる」と嘘の案内をして
    しまうため、確実に片側と読める場合以外は両方 ETC 専用として扱う。

    注意: 「出入口」は入口と出口の両方を指す。単純に "入口" を部分一致で
    探すと「出入口」にも当たってしまうので、先に取り除いてから判定する。
    """
    n = norm(note)
    both_word = "出入口" in n or "出入り口" in n
    rest = n.replace("出入口", "").replace("出入り口", "")
    has_in = "入口" in rest or "入り口" in rest
    has_out = "出口" in rest
    if both_word or (has_in and has_out) or (not has_in and not has_out):
        return {"entrance": True, "exit": True}
    return {"entrance": has_in, "exit": has_out}
