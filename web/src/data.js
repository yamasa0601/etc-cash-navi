// IC データの読み込みと検索。
//
// e フィールド (build_dataset.py と対応):
//   0 = 現金可 / 1 = 入口のみETC専用 / 2 = 出口のみETC専用 / 3 = 入口・出口ともETC専用
export const ETC_ENTRANCE = 1;
export const ETC_EXIT = 2;

// c フィールド: その施設の可否をどこまで言い切れるか
export const COVER_UNKNOWN = 0; // 有料だがNEXCO以外 (都市高速など)。データが無い
export const COVER_FREE = 1;    // 無料区間。料金所が無いので現金で通れる
export const COVER_NEXCO = 2;   // NEXCOの一覧でETC専用かどうか判断できる

// d フィールド: 片方向ランプ
const RAMP_ENTRANCE_ONLY = 1;
const RAMP_EXIT_ONLY = 2;

let cache = null;

export async function loadIcs(base = import.meta.env.BASE_URL) {
  if (cache) return cache;
  const res = await fetch(`${base}data/ic.json`);
  if (!res.ok) throw new Error(`ICデータを読み込めません (HTTP ${res.status})`);
  cache = await res.json();
  return cache;
}

/** 現金で「入れる」か。入口がETC専用でなく、出口専用ランプでもないこと。 */
export const canEnter = (ic) => (ic.e & ETC_ENTRANCE) === 0 && ic.d !== RAMP_EXIT_ONLY;

/** 現金で「出られる」か。出口がETC専用でなく、入口専用ランプでもないこと。 */
export const canExit = (ic) => (ic.e & ETC_EXIT) === 0 && ic.d !== RAMP_ENTRANCE_ONLY;

/**
 * 乗り降りの候補にしてよい施設か。
 *
 * JCT は分岐、PA/SA は本線に接するだけなので一般道から乗り降りできない。
 * 首都高・阪神高速などは NEXCO が一覧を出しておらず現金可否を判断できないため、
 * 「たぶん大丈夫」で案内せず候補から外す。
 */
export const isUsable = (ic) => ic.k === 'ic' && ic.c !== COVER_UNKNOWN;

export function distanceKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const toPoint = (ic) => ({ ...ic, lat: ic.y, lon: ic.x });

/**
 * 地点の近くで、現金で使える IC を近い順に返す。
 * @param {'enter'|'exit'} direction 入口として使うか、出口として使うか
 */
export function nearbyCashIcs(ics, point, direction, { limit = 8, maxKm = 80 } = {}) {
  const ok = direction === 'enter' ? canEnter : canExit;
  return ics
    .filter(isUsable)
    .map(toPoint)
    .filter((ic) => ok(ic))
    .map((ic) => ({ ...ic, km: distanceKm(point, ic) }))
    .filter((ic) => ic.km <= maxKm)
    .sort((a, b) => a.km - b.km)
    .slice(0, limit);
}

/** 経路の近くにある施設を拾う。警告表示用。 */
export function facilitiesNear(ics, line, predicate, withinKm = 0.3) {
  if (!line?.length) return [];
  // 経路の頂点を間引いて総当たりする。数千点 x 数百施設なので実用上は十分速い。
  const step = Math.max(1, Math.floor(line.length / 600));
  const pts = line.filter((_, i) => i % step === 0);
  const out = [];
  for (const ic of ics) {
    if (!predicate(ic)) continue;
    const p = { lat: ic.y, lon: ic.x };
    if (pts.some((q) => distanceKm(p, q) <= withinKm)) out.push(ic);
  }
  return out;
}
