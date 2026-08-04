// 地図表示。MapLibre GL JS + 地理院タイル (どちらも無料・キー不要)。
import maplibregl from 'maplibre-gl';

const GSI_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';

const STYLE = {
  version: 8,
  sources: {
    gsi: {
      type: 'raster',
      tiles: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 18,
      attribution: `${GSI_ATTRIBUTION} | ETC専用料金所: NEXCO東日本・中日本・西日本 | IC位置: &copy; OpenStreetMap contributors`,
    },
  },
  layers: [{ id: 'gsi', type: 'raster', source: 'gsi' }],
};

const EMPTY = { type: 'FeatureCollection', features: [] };

export function createMap(container) {
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  const map = new maplibregl.Map({
    container: el,
    style: STYLE,
    center: [136.9, 35.9],
    zoom: 5,
    attributionControl: { compact: true },
  });

  // グリッドのレイアウトが確定する前に初期化されると canvas が実寸より小さいまま
  // 固定されてしまう。画面回転やレスポンシブ切替でも崩れるので監視して追従する。
  const observer = new ResizeObserver(() => map.resize());
  observer.observe(el);
  map.once('remove', () => observer.disconnect());
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

  // 'load' は「最初の描画が終わったら」発火するので、タブが裏にあるなど描画が
  // 止まっている間は永久に来ない。それを待つとレイヤーが用意されず、経路を
  // 描こうとしても黙って無視されてしまう。描画に依存しない 'style.load' を使う。
  const ready = new Promise((resolve) => {
    const setup = () => {
      map.addSource('route', { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'route',
        paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.9 },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        paint: { 'line-color': '#1a73e8', 'line-width': 5 },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });

      map.addSource('ics', { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: 'ic-dots',
        type: 'circle',
        source: 'ics',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3, 10, 6, 14, 9],
          'circle-color': [
            'match', ['get', 'status'],
            'etc-only', '#d93025',   // 現金では使えない
            'partial', '#f29900',    // 入口か出口の片方だけ使える
            'unknown', '#80868b',    // 都市高速など。可否のデータが無い
            '#188038',               // 現金で使える
          ],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
        },
      });
      resolve();
    };

    if (map.isStyleLoaded()) setup();
    else map.once('style.load', setup);
  });

  return { map, ready, markers: [] };
}

export function showRoute(ctx, line) {
  const data = line?.length
    ? {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: line.map((p) => [p.lon, p.lat]) },
          properties: {},
        }],
      }
    : EMPTY;
  ctx.map.getSource('route')?.setData(data);
  if (!line?.length) return;
  const bounds = line.reduce(
    (b, p) => b.extend([p.lon, p.lat]),
    new maplibregl.LngLatBounds([line[0].lon, line[0].lat], [line[0].lon, line[0].lat]),
  );
  // 画面が小さいと固定の余白では収まらず、MapLibre が警告を出して調整を諦める。
  // 余白は canvas の大きさに対する割合で決める。
  const canvas = ctx.map.getCanvas();
  const padding = Math.max(16, Math.min(60, Math.floor(Math.min(canvas.clientWidth, canvas.clientHeight) * 0.12)));
  ctx.map.fitBounds(bounds, { padding, duration: 800 });
}

const STATUS_LABEL = {
  'cash-ok': '現金OK',
  partial: '一部ETC専用',
  'etc-only': 'ETC専用（現金では使えません）',
  unknown: '判定対象外（都市高速など。現地でご確認ください）',
};

export function icStatus(ic) {
  if (ic.c === 0) return 'unknown';
  if (ic.e === 3) return 'etc-only';
  return ic.e ? 'partial' : 'cash-ok';
}

/** 表示範囲の IC を色分けして描く。全国 4000 件を常時描くと重いので絞る。 */
export function showIcs(ctx, ics) {
  const features = ics.map((ic) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [ic.x, ic.y] },
    properties: {
      name: ic.n,
      why: ic.w,
      kind: ic.k,
      route: ic.r ?? '',
      status: icStatus(ic),
    },
  }));
  ctx.map.getSource('ics')?.setData({ type: 'FeatureCollection', features });
}

export function addPin(ctx, point, { color, label }) {
  const marker = new maplibregl.Marker({ color })
    .setLngLat([point.lon, point.lat])
    .setPopup(new maplibregl.Popup({ offset: 24 }).setText(label))
    .addTo(ctx.map);
  ctx.markers.push(marker);
  return marker;
}

export function clearPins(ctx) {
  ctx.markers.forEach((m) => m.remove());
  ctx.markers = [];
}

export function bindIcPopups(ctx) {
  const popup = new maplibregl.Popup({ closeButton: false, offset: 12 });

  const show = (e) => {
    const p = e.features[0].properties;
    const lines = [
      `<strong>${escapeHtml(p.name)}</strong>`,
      STATUS_LABEL[p.status] ?? p.status,
    ];
    if (p.route) lines.push(`<small>${escapeHtml(p.route)}</small>`);
    if (p.why) lines.push(`<small>${escapeHtml(p.why)}</small>`);
    popup.setLngLat(e.lngLat).setHTML(lines.join('<br>')).addTo(ctx.map);
  };

  ctx.map.on('mouseenter', 'ic-dots', (e) => {
    ctx.map.getCanvas().style.cursor = 'pointer';
    show(e);
  });
  ctx.map.on('mouseleave', 'ic-dots', () => {
    ctx.map.getCanvas().style.cursor = '';
    popup.remove();
  });
  ctx.map.on('click', 'ic-dots', show);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
