import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { mockApi } from './dev/mock-api.js';

const stub = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [mockApi()],
  resolve: {
    alias: {
      // kdbxweb が読み込む Node 用モジュールを、配信物に含めない
      '@xmldom/xmldom': stub('./src/stubs/xmldom.ts'),
      crypto: stub('./src/stubs/node-crypto.ts'),
    },
  },
  build: {
    outDir: 'dist',
    // CSP で外部読み込みとインラインを禁止しているので、すべて別ファイルとして自ドメインから配信する
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
