import { defineConfig } from 'vite';

// GitHub Pages はリポジトリ名がパスに入る。ユーザーページや独自ドメインに
// 置く場合は BASE_PATH=/ を渡してビルドする。
export default defineConfig({
  root: 'web',
  base: process.env.BASE_PATH ?? '/etc-cash-navi/',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
