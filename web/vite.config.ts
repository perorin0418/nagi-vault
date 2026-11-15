import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    // CSP で外部読み込みを禁止しているので、すべて自ドメインから配信する
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
