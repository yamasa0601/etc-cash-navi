// 画面の組み立てと操作の受け付け。
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

import { loadIcs } from './data.js';
import { currentPosition, geocode } from './geocode.js';
import { addPin, bindIcPopups, clearPins, createMap, showIcs, showRoute } from './map.js';
import { planTrip } from './plan.js';
import { RouterError } from './router.js';

const $ = (id) => document.getElementById(id);
const els = {
  form: $('search-form'),
  origin: $('origin'),
  dest: $('dest'),
  gps: $('use-gps'),
  submit: $('search'),
  status: $('status'),
  result: $('result'),
  meta: $('data-meta'),
};

let icData = null;
let ctx = null;
// 入力欄ごとに、利用者が選び直すまで確定した地点を覚えておく
const picked = { origin: null, dest: null };

init();

async function init() {
  // 検索は地図が無くても成立する。地図の読み込みを待って入力欄を塞がないよう、
  // フォームの配線とデータ読み込みを先に済ませる。
  els.form.addEventListener('submit', onSubmit);
  els.gps.addEventListener('click', onUseGps);
  els.origin.addEventListener('input', () => { picked.origin = null; });
  els.dest.addEventListener('input', () => { picked.dest = null; });

  ctx = createMap('map');

  try {
    icData = await loadIcs();
  } catch (err) {
    setStatus(`ICデータを読み込めませんでした: ${err.message}`, 'error');
    return;
  }

  const c = icData.counts;
  els.meta.textContent =
    `収録 ${c.facilities.toLocaleString()} 施設 / ETC専用 ${c.etc_only.toLocaleString()}`
    + `（スマートIC ${c.smart_ic.toLocaleString()} を含む）/ 現金で使えるIC ${c.usable_ic.toLocaleString()}`
    + ` / 判定対象外 ${c.unknown.toLocaleString()}・データ生成 ${icData.generated_at.slice(0, 10)}`;

  if (import.meta.env.DEV) window.__app = { ctx, icData };

  await ctx.ready;
  bindIcPopups(ctx);
  showIcsInView();
  ctx.map.on('moveend', showIcsInView);
}

/** ズームが浅いときは ETC 専用だけ描く。全国 4000 点を常時描くと重い。 */
function showIcsInView() {
  if (!icData) return;
  const zoom = ctx.map.getZoom();
  const b = ctx.map.getBounds();
  const visible = icData.ics.filter(
    (ic) => ic.x >= b.getWest() && ic.x <= b.getEast() && ic.y >= b.getSouth() && ic.y <= b.getNorth(),
  );
  showIcs(ctx, zoom < 8 ? visible.filter((ic) => ic.e) : visible);
}

async function onUseGps() {
  els.gps.disabled = true;
  try {
    const pos = await currentPosition();
    picked.origin = pos;
    els.origin.value = `${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}`;
    setStatus('現在地を出発地にしました。', 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    els.gps.disabled = false;
  }
}

async function onSubmit(event) {
  event.preventDefault();
  els.submit.disabled = true;
  els.result.hidden = true;
  clearPins(ctx);

  try {
    const origin = picked.origin ?? await resolvePlace(els.origin.value, '出発地');
    const dest = picked.dest ?? await resolvePlace(els.dest.value, '目的地');
    picked.origin = origin;
    picked.dest = dest;

    const plan = await planTrip(origin, dest, icData, { onProgress: (m) => setStatus(m, 'busy') });
    render(plan, origin, dest);
    setStatus('', '');
  } catch (err) {
    if (err?.name === 'PickCancelled') setStatus('', '');
    else if (err instanceof RouterError) setStatus(err.message, 'error');
    else setStatus(err.message ?? String(err), 'error');
  } finally {
    els.submit.disabled = false;
  }
}

/** 候補が複数あるときは選ばせる。行き先を取り違えたまま案内しないため。 */
async function resolvePlace(query, label) {
  setStatus(`${label}を検索しています…`, 'busy');
  const results = await geocode(query);
  if (!results.length) throw new Error(`${label}「${query}」が見つかりませんでした。市区町村から入力すると見つかりやすいです。`);
  if (results.length === 1) return results[0];
  return pickFromList(results, label);
}

function pickFromList(results, label) {
  return new Promise((resolve, reject) => {
    setStatus('', '');
    els.result.hidden = false;
    els.result.innerHTML = `<h2>${label}の候補</h2><p class="hint">どれかを選んでください。</p>`;
    const list = document.createElement('ul');
    list.className = 'candidates';
    results.forEach((r) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = `<span class="cand-label"></span><span class="cand-src"></span>`;
      btn.querySelector('.cand-label').textContent = r.label;
      btn.querySelector('.cand-src').textContent = r.source;
      btn.addEventListener('click', () => { els.result.hidden = true; resolve(r); });
      li.append(btn);
      list.append(li);
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ghost block';
    cancel.textContent = 'やめる';
    cancel.addEventListener('click', () => {
      els.result.hidden = true;
      const e = new Error('cancelled');
      e.name = 'PickCancelled';
      reject(e);
    });
    els.result.append(list, cancel);
  });
}

/**
 * 経路を地図に描く。地図の読み込みが終わる前に呼ばれても取りこぼさないよう、
 * 準備完了を待ってから描く (待たないと図形の追加が黙って無視される)。
 */
async function drawPlan(plan, origin, dest) {
  await ctx.ready;
  clearPins(ctx);
  showRoute(ctx, plan.line);
  addPin(ctx, origin, { color: '#5f6368', label: `出発: ${origin.label}` });
  addPin(ctx, dest, { color: '#5f6368', label: `目的: ${dest.label}` });
  if (plan.entry) addPin(ctx, { lat: plan.entry.y, lon: plan.entry.x }, { color: '#188038', label: `入口: ${plan.entry.n}（現金OK）` });
  if (plan.exit) addPin(ctx, { lat: plan.exit.y, lon: plan.exit.x }, { color: '#1a73e8', label: `出口: ${plan.exit.n}（現金OK）` });
}

function render(plan, origin, dest) {
  drawPlan(plan, origin, dest).catch((err) => setStatus(`地図に描画できませんでした: ${err.message}`, 'error'));

  const el = els.result;
  el.hidden = false;
  el.innerHTML = '';

  const h = document.createElement('h2');
  h.textContent = plan.usesExpressway ? '現金で通れる経路' : '一般道の経路';
  el.append(h);

  if (plan.reason) {
    el.append(note('info', plan.reason));
  }

  if (plan.usesExpressway) {
    const box = document.createElement('div');
    box.className = 'ic-pair';
    box.innerHTML = `
      <div class="ic-card"><span class="ic-role">高速に乗る</span><strong></strong><small>現金で入れます</small></div>
      <div class="ic-arrow">→</div>
      <div class="ic-card"><span class="ic-role">高速を降りる</span><strong></strong><small>現金で出られます</small></div>`;
    const [a, b] = box.querySelectorAll('strong');
    a.textContent = `${plan.entry.n}（${plan.entry.p}）`;
    b.textContent = `${plan.exit.n}（${plan.exit.p}）`;
    el.append(box);
  }

  const stats = document.createElement('dl');
  stats.className = 'stats';
  stats.innerHTML = `
    <div><dt>距離</dt><dd>${plan.distanceKm.toFixed(1)} km</dd></div>
    <div><dt>所要時間</dt><dd>${formatDuration(plan.seconds)}</dd></div>`;
  if (plan.usesExpressway) {
    const saved = plan.surfaceOnly.seconds - plan.seconds;
    const d = document.createElement('div');
    d.innerHTML = `<dt>一般道のみとの差</dt><dd>${saved > 0 ? `約${formatDuration(saved)}短縮` : '差はほぼなし'}</dd>`;
    stats.append(d);
  }
  el.append(stats);

  plan.warnings.forEach((w) => el.append(note(w.level, w.text, w.detail)));

  const open = document.createElement('a');
  open.className = 'primary block';
  open.href = plan.googleMapsUrl;
  open.target = '_blank';
  open.rel = 'noopener';
  open.textContent = 'Googleマップでナビを開始';
  el.append(open);

  el.append(note('info', '料金所の運用は変わります。現地の表示を必ず確認してください。'));

  if (plan.steps.length) {
    const details = document.createElement('details');
    details.className = 'steps';
    details.innerHTML = '<summary>道順を見る</summary>';
    const ol = document.createElement('ol');
    plan.steps.forEach((s) => {
      const li = document.createElement('li');
      li.textContent = s;
      ol.append(li);
    });
    details.append(ol);
    el.append(details);
  }
}

function note(level, text, detail) {
  const div = document.createElement('div');
  div.className = `note ${level}`;
  const p = document.createElement('p');
  p.textContent = text;
  div.append(p);
  if (detail) {
    const small = document.createElement('small');
    small.textContent = detail;
    div.append(small);
  }
  return div;
}

function formatDuration(seconds) {
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}時間${m}分` : `${m}分`;
}

function setStatus(message, kind) {
  els.status.textContent = message;
  els.status.className = `status ${kind ?? ''}`.trim();
}
