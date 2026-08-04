// 経路計算。OSM の公開 Valhalla サーバーを使う (APIキー不要・無料)。
//
// use_tolls: 0 = 有料道路を避ける / 1 = 有料道路を使う
// 一般道区間と高速区間を別々に計算し、選んだ IC を経由地として最終経路を組む。
const ENDPOINT = 'https://valhalla1.openstreetmap.de';

class RouterError extends Error {}

async function call(path, body) {
  let res;
  try {
    res = await fetch(`${ENDPOINT}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new RouterError(`経路サーバーに接続できません: ${err.message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 429) throw new RouterError('経路サーバーが混雑しています。少し待って再試行してください。');
    throw new RouterError(`経路サーバーエラー (HTTP ${res.status}) ${text.slice(0, 120)}`);
  }
  return res.json();
}

const costing = (useTolls) => ({
  costing: 'auto',
  costing_options: { auto: { use_tolls: useTolls } },
});

const loc = (p) => ({ lat: p.lat, lon: p.lon });

/** 地点間の所要時間・距離の総当たり表を得る。候補 IC の絞り込みに使う。 */
export async function matrix(sources, targets, useTolls) {
  if (!sources.length || !targets.length) return [];
  const data = await call('/sources_to_targets', {
    sources: sources.map(loc),
    targets: targets.map(loc),
    ...costing(useTolls),
  });
  return data.sources_to_targets ?? [];
}

/** 経由地を含む経路を計算する。日本語の案内文つき。 */
export async function route(points, useTolls) {
  const data = await call('/route', {
    locations: points.map(loc),
    ...costing(useTolls),
    directions_options: { units: 'kilometers', language: 'ja-JP' },
  });
  const legs = data.trip?.legs ?? [];
  return {
    distanceKm: data.trip?.summary?.length ?? 0,
    seconds: data.trip?.summary?.time ?? 0,
    line: legs.flatMap((l) => decodePolyline(l.shape)),
    steps: legs.flatMap((l) => (l.maneuvers ?? []).map((m) => m.instruction).filter(Boolean)),
  };
}

/** Valhalla の encoded polyline (精度6) をデコードする。 */
export function decodePolyline(str, precision = 6) {
  if (!str) return [];
  const factor = 10 ** precision;
  const out = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < str.length) {
    for (const axis of ['lat', 'lon']) {
      let shift = 0;
      let result = 0;
      let byte;
      do {
        byte = str.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 'lat') lat += delta;
      else lon += delta;
    }
    out.push({ lat: lat / factor, lon: lon / factor });
  }
  return out;
}

export { RouterError };
