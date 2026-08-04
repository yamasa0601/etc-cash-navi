// 地名・住所から緯度経度を引く。
//
// 国土地理院は住所に強いが施設名に弱く (「名古屋駅」で千葉県の地名が出る)、
// Nominatim は施設名に強い。両方引いて候補を並べ、利用者に選んでもらう。
// 行き先を取り違えたまま案内するより、1 タップ選ばせる方が安全。
const GSI = 'https://msearch.gsi.go.jp/address-search/AddressSearch';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

async function fromGsi(query) {
  const res = await fetch(`${GSI}?q=${encodeURIComponent(query)}`);
  if (!res.ok) return [];
  const json = await res.json();
  return (Array.isArray(json) ? json : []).slice(0, 5).map((f) => ({
    label: f.properties?.title ?? query,
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    source: '国土地理院',
  }));
}

async function fromNominatim(query) {
  const url = `${NOMINATIM}?format=jsonv2&countrycodes=jp&accept-language=ja&limit=5&q=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  return json.map((f) => ({
    label: f.display_name.replace(/, 日本$/, ''),
    lat: Number(f.lat),
    lon: Number(f.lon),
    source: 'OpenStreetMap',
  }));
}

export async function geocode(query) {
  const q = query.trim();
  if (!q) return [];

  // 「35.1, 136.9」のような座標直接入力も受ける
  const coord = q.match(/^\s*(-?\d+\.\d+)\s*[,、]\s*(-?\d+\.\d+)\s*$/);
  if (coord) {
    return [{ label: `緯度経度 ${coord[1]}, ${coord[2]}`, lat: Number(coord[1]), lon: Number(coord[2]), source: '直接入力' }];
  }

  const [gsi, osm] = await Promise.all([
    fromGsi(q).catch(() => []),
    fromNominatim(q).catch(() => []),
  ]);

  // 近すぎる候補は同じ場所とみなして 1 つに絞る
  const out = [];
  for (const c of [...gsi, ...osm]) {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
    if (out.some((o) => Math.abs(o.lat - c.lat) < 0.002 && Math.abs(o.lon - c.lon) < 0.002)) continue;
    out.push(c);
  }
  return out.slice(0, 8);
}

export function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('この端末では現在地を取得できません'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        label: '現在地',
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        source: 'GPS',
      }),
      (err) => reject(new Error(`現在地を取得できません: ${err.message}`)),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });
}
