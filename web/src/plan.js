// 現金で通れる経路を組み立てる。
//
// 日本の高速道路は「入口で券を取り、出口で払う」ので、現金で走り切れるかどうかは
// 入口 IC と出口 IC がそれぞれ現金に対応しているかで決まる。途中で通過するだけの
// IC は関係ない。ただし本線料金所が ETC 専用だとその区間自体を通れない。
//
// そこで:
//   1. 出発地の近くで「現金で入れる」IC を候補として集める
//   2. 目的地の近くで「現金で出られる」IC を候補として集める
//   3. 総当たり表で (一般道 + 高速 + 一般道) の合計時間が最小の組を選ぶ
//   4. 区間ごとに有料道路の可否を分けて経路を確定する
import { COVER_UNKNOWN, distanceKm, facilitiesNear, isUsable, nearbyCashIcs } from './data.js';
import { matrix, route } from './router.js';

const CANDIDATES = 8;
const SEARCH_RADIUS_KM = 80;
// 都市高速を避けた組み合わせを探すために実際に引き直す上限。公開サーバーへの
// 負荷とレスポンスのバランスでこの程度に留める。
const CHECKED_PAIRS = 3;
// 判断できない道を避けるために許容する遠回りの上限 (最短比)
const TIME_TOLERANCE = 1.2;

const cell = (m, i, j) => m?.[i]?.[j] ?? null;
const timeOf = (c) => (c && c.time != null ? c.time : Infinity);

export async function planTrip(origin, dest, icData, { onProgress = () => {} } = {}) {
  const ics = icData.ics;
  const opts = { limit: CANDIDATES, maxKm: SEARCH_RADIUS_KM };

  onProgress('現金で使えるICを探しています…');
  const entries = nearbyCashIcs(ics, origin, 'enter', opts);
  const exits = nearbyCashIcs(ics, dest, 'exit', opts);

  onProgress('経路を比較しています…');
  // 高速を使わない場合の基準経路。候補が無いときのフォールバックも兼ねる。
  const surfaceOnly = await route([origin, dest], 0);

  if (!entries.length || !exits.length) {
    return finish({
      origin, dest, ics,
      legs: [surfaceOnly],
      entry: null, exit: null,
      surfaceOnly,
      reason: '出発地または目的地の近くに、現金で使えるICが見つかりませんでした。一般道の経路を表示します。',
    });
  }

  const [toEntry, fromExit, mid] = await Promise.all([
    matrix([origin], entries, 0),
    matrix(exits, [dest], 0),
    matrix(entries, exits, 1),
  ]);

  const pairs = [];
  for (let i = 0; i < entries.length; i += 1) {
    const inTime = timeOf(cell(toEntry, 0, i));
    if (!Number.isFinite(inTime)) continue;
    for (let j = 0; j < exits.length; j += 1) {
      // 同じ IC で乗り降りしても意味がない
      if (entries[i].n === exits[j].n && entries[i].p === exits[j].p) continue;
      const total = inTime + timeOf(cell(mid, i, j)) + timeOf(cell(fromExit, j, 0));
      if (!Number.isFinite(total)) continue;
      pairs.push({ total, entry: entries[i], exit: exits[j] });
    }
  }
  pairs.sort((a, b) => a.total - b.total);
  const best = pairs[0];

  if (!best || best.total >= surfaceOnly.seconds) {
    return finish({
      origin, dest, ics,
      legs: [surfaceOnly],
      entry: null, exit: null,
      surfaceOnly,
      reason: best
        ? '現金で使えるICを経由するより、一般道の方が早いか同等でした。'
        : '現金で通れる高速の組み合わせが見つかりませんでした。',
    });
  }

  onProgress('経路を確定しています…');
  // 最短の組み合わせが都市高速を通ってしまうことがある。そこは現金可否を
  // 判断できないので、少し遅くても判断できる道だけで済む組を優先する。
  let fallback = null;
  for (const pair of pairs.slice(0, CHECKED_PAIRS)) {
    if (pair.total > best.total * TIME_TOLERANCE) break;
    const legs = await buildLegs(origin, dest, pair);
    const result = finish({ origin, dest, ics, legs, entry: pair.entry, exit: pair.exit, surfaceOnly });
    if (!result.warnings.some((w) => w.level === 'warning')) return result;
    fallback ??= result;
  }
  return fallback ?? finish({
    origin, dest, ics,
    legs: await buildLegs(origin, dest, best),
    entry: best.entry, exit: best.exit, surfaceOnly,
  });
}

/**
 * 区間ごとに有料道路の可否を変えて経路を引く。
 * 全体を一度に計算すると、選んだ IC より手前で高速に乗って ETC 専用 IC を
 * 通りかねないので、一般道と高速を分けて計算する。
 */
async function buildLegs(origin, dest, pair) {
  const [toEntryLeg, fromExitLeg] = await Promise.all([
    route([origin, pair.entry], 0),
    route([pair.exit, dest], 0),
  ]);

  // IC の座標は本線上の分岐点なので、そこを起終点にすると上下線のどちら側に
  // 付くかが定まらず、逆方向に走ってから U ターンする経路になることがある。
  // 前後の一般道の点をつないで、進入・退出の方向を確定させる。
  const approach = pointBefore(toEntryLeg.line, 0.3) ?? pair.entry;
  const departure = pointAfter(fromExitLeg.line, 0.3) ?? pair.exit;
  const expressway = await route([approach, departure], 1);

  return [toEntryLeg, expressway, fromExitLeg];
}

/** 経路の終点から指定距離だけ手前の点。高速へ入る向きの手がかりに使う。 */
function pointBefore(line, km) {
  if (!line?.length) return null;
  const end = line[line.length - 1];
  for (let i = line.length - 1; i >= 0; i -= 1) {
    if (distanceKm(end, line[i]) >= km) return line[i];
  }
  return line[0];
}

/** 経路の始点から指定距離だけ進んだ点。高速から出る向きの手がかりに使う。 */
function pointAfter(line, km) {
  if (!line?.length) return null;
  const start = line[0];
  return line.find((p) => distanceKm(start, p) >= km) ?? line[line.length - 1];
}

function finish({ origin, dest, ics, legs, entry, exit, surfaceOnly, reason = '' }) {
  const line = legs.flatMap((l) => l.line);
  const distanceKmTotal = legs.reduce((s, l) => s + l.distanceKm, 0);
  const seconds = legs.reduce((s, l) => s + l.seconds, 0);

  // 経路上に ETC 専用の本線料金所があれば、その区間は現金で通り抜けられない
  const blockedMainline = facilitiesNear(ics, line, (ic) => ic.e && ic.k === 'mainline');

  // NEXCO 以外の有料道路 (都市高速など) に乗ってしまうと可否を保証できない。
  // 判定は高速区間だけを見る。一般道区間は有料道路を避けて計算しているうえ、
  // 都市高速は一般道の真上を通るので、近いというだけでは通行の証拠にならない。
  const expressway = entry && exit ? legs[1] : null;
  const nearUnknown = expressway
    ? facilitiesNear(ics, expressway.line, (ic) => ic.c === COVER_UNKNOWN, 0.06)
    : [];
  const unverified = new Set(nearUnknown.map((ic) => ic.n)).size >= 3 ? nearUnknown : [];

  return {
    entry, exit, legs, line, reason,
    distanceKm: distanceKmTotal,
    seconds,
    usesExpressway: Boolean(entry && exit),
    steps: legs.flatMap((l) => l.steps),
    surfaceOnly: { distanceKm: surfaceOnly.distanceKm, seconds: surfaceOnly.seconds },
    warnings: buildWarnings({ origin, dest, ics, entry, exit, blockedMainline, unverified }),
    googleMapsUrl: googleMapsUrl(origin, dest, entry, exit),
  };
}

function buildWarnings({ origin, dest, ics, entry, exit, blockedMainline, unverified }) {
  const warnings = [];

  for (const tb of blockedMainline) {
    warnings.push({
      level: 'danger',
      text: `経路上の「${tb.n}」はETC専用の本線料金所です。この区間は現金で通り抜けられません。`,
      detail: tb.w,
    });
  }

  if (unverified.length) {
    const names = [...new Set(unverified.map((ic) => ic.n))].slice(0, 3).join('、');
    warnings.push({
      level: 'warning',
      text: '経路に都市高速など、NEXCOがETC専用料金所の一覧を公開していない道路が含まれます。この区間の現金可否は判断できません。',
      detail: `該当箇所の例: ${names}`,
    });
  }

  // 「もっと近いICがあるのに、なぜ遠回りさせられるのか」を説明する
  if (entry) {
    const skipped = nearestEtcOnly(ics, origin, entry);
    if (skipped) {
      warnings.push({
        level: 'info',
        text: `出発地に最も近い「${skipped.n}」はETC専用のため使えません。${entry.n}から乗る経路にしています。`,
        detail: skipped.w,
      });
    }
  }
  if (exit) {
    const skipped = nearestEtcOnly(ics, dest, exit);
    if (skipped) {
      warnings.push({
        level: 'info',
        text: `目的地に最も近い「${skipped.n}」はETC専用のため使えません。${exit.n}で降りる経路にしています。`,
        detail: skipped.w,
      });
    }
  }
  return warnings;
}

/** 選んだ IC より手前にある ETC 専用 IC を 1 つ返す (説明用)。 */
function nearestEtcOnly(ics, point, chosen) {
  const chosenKm = distanceKm(point, { lat: chosen.y ?? chosen.lat, lon: chosen.x ?? chosen.lon });
  let best = null;
  for (const ic of ics) {
    if (!ic.e || !isUsable(ic)) continue;
    const km = distanceKm(point, { lat: ic.y, lon: ic.x });
    if (km < chosenKm && (!best || km < best.km)) best = { ...ic, km };
  }
  return best;
}

/** 実際の運転は Google マップに渡す。経由地に選んだ IC を入れる。 */
function googleMapsUrl(origin, dest, entry, exit) {
  const p = (o) => `${o.lat},${o.lon}`;
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('origin', p(origin));
  url.searchParams.set('destination', p(dest));
  if (entry && exit) {
    url.searchParams.set('waypoints', `${p({ lat: entry.y, lon: entry.x })}|${p({ lat: exit.y, lon: exit.x })}`);
  }
  url.searchParams.set('travelmode', 'driving');
  return url.toString();
}
