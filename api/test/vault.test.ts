import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { createHandler, MAX_VAULT_BYTES, vaultKey, type UploadCondition, type VaultStore } from '../src/vault.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

/** 呼び出しを記録するだけのストア */
function fakeStore(existing: Record<string, { etag: string; size: number }> = {}) {
  const calls: string[] = [];
  const store: VaultStore = {
    async head(key) {
      calls.push(`head ${key}`);
      return existing[key] ?? null;
    },
    async presignGet(key, expiresIn) {
      calls.push(`presignGet ${key}`);
      return `https://s3.example/${key}?get&exp=${expiresIn}`;
    },
    async presignPut(key, size, cond: UploadCondition, expiresIn) {
      calls.push(`presignPut ${key} ${size} ${JSON.stringify(cond)}`);
      return `https://s3.example/${key}?put&exp=${expiresIn}`;
    },
  };
  return { store, calls };
}

function event(opts: { method: string; path?: string; sub?: string | undefined; body?: unknown; rawBody?: string; headers?: Record<string, string> }): APIGatewayProxyEventV2WithJWTAuthorizer {
  const path = opts.path ?? '/api/vault';
  const body = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  return {
    version: '2.0',
    routeKey: `${opts.method} ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: opts.headers ?? {},
    isBase64Encoded: false,
    body,
    requestContext: {
      http: { method: opts.method, path, protocol: 'HTTP/1.1', sourceIp: '0.0.0.0', userAgent: 'test' },
      authorizer: { principalId: '', integrationLatency: 0, jwt: { claims: opts.sub === undefined ? {} : { sub: opts.sub }, scopes: [] } },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

const upload = (sub: string, body: unknown) => event({ method: 'POST', path: '/api/vault/upload-url', sub, body });

function setup(existing?: Record<string, { etag: string; size: number }>) {
  const s = fakeStore(existing);
  const logs: Record<string, unknown>[] = [];
  return { ...s, logs, handler: createHandler(s.store, (r) => logs.push(r)) };
}

const parse = (r: { body?: string }) => JSON.parse(r.body ?? '{}') as Record<string, unknown>;

describe('vaultKey', () => {
  it('sub から保存先を作る', () => {
    expect(vaultKey(ALICE)).toBe(`vaults/${ALICE}/vault.kdbx`);
  });
  it.each(['', '../x', `${ALICE}/../${BOB}`, 'ALICE', `${ALICE} `])('不正な sub を拒否する: %j', (s) => {
    expect(() => vaultKey(s)).toThrow();
  });
});

describe('保存先は必ずトークンの sub から作られる', () => {
  it('本文やヘッダーに他人の ID やキーを入れても、自分の保管庫の URL しか発行しない', async () => {
    const { handler, calls } = setup({ [vaultKey(ALICE)]: { etag: '"a1"', size: 10 } });
    await handler(event({ method: 'GET', sub: ALICE, headers: { 'x-user': BOB } }));
    await handler(upload(ALICE, { size: 10, ifMatch: '"a1"', key: `vaults/${BOB}/vault.kdbx`, sub: BOB }));
    expect(calls).toEqual([
      `head vaults/${ALICE}/vault.kdbx`,
      `presignGet vaults/${ALICE}/vault.kdbx`,
      `presignPut vaults/${ALICE}/vault.kdbx 10 {"ifMatch":"\\"a1\\""}`,
    ]);
  });

  it('別の利用者には他人の保管庫が見えない（自分の保管庫がなければ 404）', async () => {
    const { handler } = setup({ [vaultKey(ALICE)]: { etag: '"a1"', size: 10 } });
    expect((await handler(event({ method: 'GET', sub: BOB }))).statusCode).toBe(404);
  });

  it('sub がない・不正なら 401 で、S3 に触れない', async () => {
    const { handler, calls } = setup();
    expect((await handler(event({ method: 'GET', sub: undefined }))).statusCode).toBe(401);
    expect((await handler(upload('../etc', { size: 1, ifNoneMatch: '*' }))).statusCode).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe('GET /api/vault', () => {
  it('未作成なら 404 と上限を返す', async () => {
    const { handler } = setup();
    const res = await handler(event({ method: 'GET', sub: ALICE }));
    expect(res.statusCode).toBe(404);
    expect(parse(res)['maxBytes']).toBe(MAX_VAULT_BYTES);
  });

  it('作成済みなら ETag・サイズ・ダウンロード用 URL を返す', async () => {
    const { handler } = setup({ [vaultKey(ALICE)]: { etag: '"a1"', size: 1234 } });
    const res = await handler(event({ method: 'GET', sub: ALICE }));
    expect(res.statusCode).toBe(200);
    expect(parse(res)).toMatchObject({ etag: '"a1"', size: 1234, maxBytes: MAX_VAULT_BYTES, downloadUrl: expect.stringContaining('get') });
    expect(res.headers?.['cache-control']).toBe('no-store');
  });
});

describe('POST /api/vault/upload-url', () => {
  it('新規作成：If-None-Match を署名に含めた URL と、付けるべきヘッダーを返す', async () => {
    const { handler, calls } = setup();
    const res = await handler(upload(ALICE, { size: 100, ifNoneMatch: '*' }));
    expect(res.statusCode).toBe(200);
    expect(parse(res)).toMatchObject({ uploadUrl: expect.stringContaining('put'), headers: { 'content-type': 'application/octet-stream', 'if-none-match': '*' } });
    expect(calls).toEqual([`presignPut vaults/${ALICE}/vault.kdbx 100 {"ifNoneMatch":"*"}`]);
  });

  it('更新：If-Match を署名に含めた URL と、付けるべきヘッダーを返す', async () => {
    const { handler } = setup();
    const res = await handler(upload(ALICE, { size: 100, ifMatch: '"abc123"' }));
    expect(res.statusCode).toBe(200);
    expect(parse(res)['headers']).toEqual({ 'content-type': 'application/octet-stream', 'if-match': '"abc123"' });
  });

  it('条件なしは 428（URL を発行しない）', async () => {
    const { handler, calls } = setup();
    expect((await handler(upload(ALICE, { size: 100 }))).statusCode).toBe(428);
    expect(calls).toEqual([]);
  });

  it.each([
    ['両方の条件', { size: 1, ifMatch: '"a"', ifNoneMatch: '*' }],
    ['* 以外の If-None-Match', { size: 1, ifNoneMatch: '"a"' }],
    ['引用符のない ETag', { size: 1, ifMatch: 'abc' }],
    ['改行を含む ETag', { size: 1, ifMatch: '"a"\r\nx-amz-acl: public-read' }],
    ['大きさがない', { ifNoneMatch: '*' }],
    ['大きさが 0', { size: 0, ifNoneMatch: '*' }],
    ['大きさが小数', { size: 1.5, ifNoneMatch: '*' }],
    ['大きさが文字列', { size: '10', ifNoneMatch: '*' }],
  ])('%s は 400（URL を発行しない）', async (_, body) => {
    const { handler, calls } = setup();
    expect((await handler(upload(ALICE, body))).statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it('JSON でない本文、配列、大きすぎる本文は 400', async () => {
    const { handler } = setup();
    for (const rawBody of ['not json', '[1]', JSON.stringify({ size: 1, ifNoneMatch: '*', pad: 'x'.repeat(2000) })]) {
      expect((await handler(event({ method: 'POST', path: '/api/vault/upload-url', sub: ALICE, rawBody }))).statusCode).toBe(400);
    }
  });

  it('上限ちょうどは発行し、1 バイトでも超えたら 413', async () => {
    const { handler } = setup();
    expect((await handler(upload(ALICE, { size: MAX_VAULT_BYTES, ifNoneMatch: '*' }))).statusCode).toBe(200);
    const over = await handler(upload(ALICE, { size: MAX_VAULT_BYTES + 1, ifNoneMatch: '*' }));
    expect(over.statusCode).toBe(413);
    expect(parse(over)['maxBytes']).toBe(MAX_VAULT_BYTES);
  });
});

describe('その他', () => {
  it('定義していない経路・メソッドは 404', async () => {
    const { handler } = setup();
    expect((await handler(event({ method: 'PUT', sub: ALICE }))).statusCode).toBe(404);
    expect((await handler(event({ method: 'GET', path: '/api/other', sub: ALICE }))).statusCode).toBe(404);
  });

  it('S3 の想定外のエラーは 500 にし、詳細を返さない', async () => {
    const store: VaultStore = {
      head: async () => { throw new Error('boom secret'); },
      presignGet: async () => '',
      presignPut: async () => '',
    };
    const logs: Record<string, unknown>[] = [];
    const res = await createHandler(store, (r) => logs.push(r))(event({ method: 'GET', sub: ALICE }));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('boom');
    expect(JSON.stringify(logs)).not.toContain('boom');
  });

  it('ログに URL・ETag・トークンを出さない', async () => {
    const { handler, logs } = setup({ [vaultKey(ALICE)]: { etag: '"a1"', size: 10 } });
    await handler(event({ method: 'GET', sub: ALICE, headers: { authorization: 'Bearer SECRET-TOKEN' } }));
    await handler(upload(ALICE, { size: 10, ifMatch: '"a1"' }));
    const all = JSON.stringify(logs);
    expect(all).not.toContain('SECRET-TOKEN');
    expect(all).not.toContain('s3.example');
    expect(all).not.toContain('a1');
    expect(logs.every((l) => Object.keys(l).every((k) => ['level', 'sub', 'method', 'path', 'status', 'bytes', 'ms', 'error'].includes(k)))).toBe(true);
  });
});
