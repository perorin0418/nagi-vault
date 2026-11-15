// `npm run dev` のときだけ使う模擬 API。本番の配信物には含まれない（vite.config.ts で serve 時のみ有効）。
// 本番と同じ流れ（API が URL を発行 → その URL に直接 GET / PUT。条件は S3 と同じ規則）を、メモリ上の保管庫1つで真似る。
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX = 64 * 1024 * 1024;

export function mockApi(): Plugin {
  let vault: { body: Buffer; etag: string } | null = null;
  let n = 0;
  /** 発行した URL に付けた条件（本番では署名に含まれ、変えると 403） */
  const issued = new Map<string, { size: number; ifMatch?: string; ifNoneMatch?: string }>();

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.statusCode = status;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    if (Buffer.isBuffer(body)) res.end(body);
    else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); }
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });

  return {
    name: 'nagi-vault-mock-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/config.json', (_req, res) => {
        send(res, 200, { region: 'local', userPoolId: 'local', userPoolClientId: 'local', cognitoDomain: 'localhost', dev: true });
      });
      server.middlewares.use('/api/vault/upload-url', async (req, res) => {
        if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
        const { size, ifMatch, ifNoneMatch } = JSON.parse((await readBody(req)).toString() || '{}');
        if (!ifMatch && !ifNoneMatch) return send(res, 428, { error: 'precondition required' });
        if (size > MAX) return send(res, 413, { error: 'vault too large', maxBytes: MAX });
        const id = String(++n);
        issued.set(id, { size, ifMatch, ifNoneMatch });
        send(res, 200, {
          uploadUrl: `/__dev/blob?u=${id}`,
          headers: { 'content-type': 'application/octet-stream', ...(ifMatch ? { 'if-match': ifMatch } : { 'if-none-match': '*' }) },
          expiresIn: 300,
        });
      });
      server.middlewares.use('/api/vault', (req, res) => {
        if (req.method !== 'GET') return send(res, 404, { error: 'not found' });
        if (!vault) return send(res, 404, { error: 'vault not found', maxBytes: MAX });
        send(res, 200, { etag: vault.etag, size: vault.body.length, maxBytes: MAX, downloadUrl: '/__dev/blob' });
      });
      // S3 の代わり
      server.middlewares.use('/__dev/blob', async (req, res) => {
        if (req.method === 'GET') {
          if (!vault) return send(res, 404, { error: 'NoSuchKey' });
          return send(res, 200, vault.body, { etag: vault.etag, 'content-type': 'application/octet-stream' });
        }
        const u = new URL(req.url ?? '', 'http://x').searchParams.get('u') ?? '';
        const cond = issued.get(u);
        const body = await readBody(req);
        // 署名と違うヘッダー・大きさは 403（本番の S3 と同じ）
        if (!cond || body.length !== cond.size || req.headers['if-match'] !== cond.ifMatch || req.headers['if-none-match'] !== cond.ifNoneMatch) {
          return send(res, 403, { error: 'SignatureDoesNotMatch' });
        }
        if (cond.ifNoneMatch === '*' && vault) return send(res, 412, { error: 'PreconditionFailed' });
        if (cond.ifMatch && !vault) return send(res, 404, { error: 'NoSuchKey' });
        if (cond.ifMatch && vault && vault.etag !== cond.ifMatch) return send(res, 412, { error: 'PreconditionFailed' });
        vault = { body, etag: `"dev-${++n}"` };
        send(res, 200, '', { etag: vault.etag });
      });
    },
  };
}
