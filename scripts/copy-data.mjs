// data/ic.json を web/public に配置する。Vite の publicDir 経由で配信される。
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'data/ic.json');
const dest = resolve(root, 'web/public/data/ic.json');

if (!existsSync(src)) {
  console.error('data/ic.json がありません。先に `npm run data` を実行してください。');
  process.exit(1);
}

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`copied ic.json (${(statSync(dest).size / 1024).toFixed(0)} KB) -> web/public/data/`);
