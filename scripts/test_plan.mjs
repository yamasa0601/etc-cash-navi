// 経路計画の結合テスト。`node scripts/test_plan.mjs` で実行。
// 実際に公開 Valhalla サーバーを叩くのでネットワークが必要。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const icData = JSON.parse(readFileSync(resolve(root, 'data/ic.json'), 'utf8'));

const { canEnter, canExit, isUsable, distanceKm, nearbyCashIcs } = await import('../web/src/data.js');
const { planTrip } = await import('../web/src/plan.js');

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); return ok; };

function nearestUsable(point, direction) {
  const ok = direction === 'enter' ? canEnter : canExit;
  return icData.ics
    .filter(isUsable)
    .map((ic) => ({ ...ic, lat: ic.y, lon: ic.x, km: distanceKm(point, { lat: ic.y, lon: ic.x }) }))
    .sort((a, b) => a.km - b.km)
    .filter((ic) => ic.km < 40)
    .map((ic) => ({ ...ic, cashOk: ok(ic) }));
}

const CASES = [
  {
    name: '金沢 → 名古屋（県外の長距離）',
    origin: { label: '金沢市広岡', lat: 36.578396, lon: 136.646301 },
    dest: { label: '名古屋市中村区名駅', lat: 35.170694, lon: 136.881637 },
    expectExpressway: true,
  },
  {
    name: '川崎（東名川崎ICがETC専用）→ 静岡',
    origin: { label: '川崎市宮前区', lat: 35.5875, lon: 139.5806 },
    dest: { label: '静岡市葵区', lat: 34.9756, lon: 138.3828 },
    expectExpressway: true,
  },
  {
    name: '京都（第二京阪に入口のみETC専用が集中）→ 大阪',
    origin: { label: '京都市伏見区', lat: 34.9320, lon: 135.7600 },
    dest: { label: '大阪市中央区', lat: 34.6850, lon: 135.5090 },
    expectExpressway: false, // 近距離なので高速なしになることもある。どちらでも可
  },
];

console.log(`データ: ${icData.counts.facilities} 施設 / ETC専用 ${icData.counts.etc_only}\n`);

for (const c of CASES) {
  console.log(`── ${c.name}`);
  let plan;
  try {
    plan = await planTrip(c.origin, c.dest, icData);
  } catch (err) {
    failures.push(`${c.name}: 例外 ${err.message}`);
    console.log(`   ERROR ${err.message}\n`);
    continue;
  }

  console.log(`   距離 ${plan.distanceKm.toFixed(1)}km / ${Math.round(plan.seconds / 60)}分`);
  if (plan.usesExpressway) {
    console.log(`   入口: ${plan.entry.n}（${plan.entry.p}） e=${plan.entry.e}`);
    console.log(`   出口: ${plan.exit.n}（${plan.exit.p}） e=${plan.exit.e}`);
  } else {
    console.log(`   高速なし: ${plan.reason}`);
  }
  plan.warnings.forEach((w) => console.log(`   [${w.level}] ${w.text}`));

  // 最重要: 選ばれた IC が本当に現金で使えること
  if (plan.usesExpressway) {
    check(canEnter(plan.entry), `${c.name}: 入口 ${plan.entry.n} が現金で入れない (e=${plan.entry.e})`);
    check(canExit(plan.exit), `${c.name}: 出口 ${plan.exit.n} が現金で出られない (e=${plan.exit.e})`);
    check(plan.entry.k === 'ic', `${c.name}: 入口 ${plan.entry.n} が IC ではない (${plan.entry.k})`);
    check(plan.exit.k === 'ic', `${c.name}: 出口 ${plan.exit.n} が IC ではない (${plan.exit.k})`);
    check(plan.line.length > 10, `${c.name}: 経路の形状が取れていない`);
    check(plan.googleMapsUrl.includes('waypoints'), `${c.name}: Googleマップのリンクに経由地が無い`);
  }

  // 参考: 出発地に最も近い IC が ETC 専用だったか (避けられているかの確認用)
  const nearIn = nearestUsable(c.origin, 'enter')[0];
  if (nearIn) {
    console.log(`   参考: 出発地最寄り ${nearIn.n} は ${nearIn.cashOk ? '現金OK' : 'ETC専用'}（${nearIn.km.toFixed(1)}km）`);
  }
  console.log('');
}

// 候補抽出そのものの検証: 現金で使えない IC が候補に混ざっていないこと
const spot = { lat: 35.5875, lon: 139.5806 };
for (const dir of ['enter', 'exit']) {
  const cands = nearbyCashIcs(icData.ics, spot, dir, { limit: 20, maxKm: 60 });
  const bad = cands.filter((ic) => (dir === 'enter' ? !canEnter(ic) : !canExit(ic)));
  check(bad.length === 0, `候補抽出(${dir}) に ETC 専用が混入: ${bad.map((b) => b.n).join(', ')}`);
  check(cands.every((ic) => ic.k === 'ic'), `候補抽出(${dir}) に IC 以外が混入`);
}

if (failures.length) {
  console.log(`FAILED (${failures.length})`);
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('OK  すべての検証を通過');
