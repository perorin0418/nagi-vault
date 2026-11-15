// `npm run dev` のときだけ使う模擬 API。本番の配信物には含まれない（vite.config.ts で serve 時のみ有効）。
// 本番の Lambda と同じ規則（If-Match / If-None-Match、412 / 404 / 413 / 428）で、保管庫をメモリ上に1つだけ持つ。
import type { Plugin } from 'vite';

const MAX = 4 * 1024 * 1024;

export function mockApi(): Plugin {
  let vault: { body: Buffer; etag: string } | null = null;
  let n = 0;
  return {
    name: 'nagi-vault-mock-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/config.json', (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ region: 'local', userPoolId: 'local', userPoolClientId: 'local', cognitoDomain: 'localhost', dev: true }));
      });
      // 412 の動作を試すため、別端末からの保存を模擬する
      server.middlewares.use('/__dev/touch', (_req, res) => {
        if (vault) vault = { ...vault, etag: `"dev-${++n}"` };
        res.end('ok');
      });
      server.middlewares.use('/api/vault', (req, res) => {
        const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
          res.statusCode = status;
          for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
          if (Buffer.isBuffer(body)) res.end(body);
          else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); }
        };
        if (req.method === 'GET') {
          if (!vault) return send(404, { error: 'vault not found' });
          return send(200, vault.body, { etag: vault.etag, 'content-type': 'application/octet-stream' });
        }
        if (req.method !== 'PUT') return send(405, { error: 'method not allowed' });
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          const ifMatch = req.headers['if-match'];
          const ifNoneMatch = req.headers['if-none-match'];
          if (!ifMatch && !ifNoneMatch) return send(428, { error: 'precondition required' });
          if (body.length > MAX) return send(413, { error: 'vault too large', maxBytes: MAX });
          if (ifNoneMatch === '*' ? vault : !vault || vault.etag !== ifMatch) return send(412, { error: 'precondition failed' });
          const created = !vault;
          vault = { body, etag: `"dev-${++n}"` };
          send(created ? 201 : 200, { etag: vault.etag }, { etag: vault.etag });
        });
      });
    },
  };
}
