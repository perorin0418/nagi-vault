import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { createHandler, MAX_VAULT_BYTES, PreconditionFailedError, vaultKey, type VaultStore } from '../src/vault.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

/** S3 の条件付き書き込みを真似るメモリ上のストア */
function memoryStore() {
  const objects = new Map<string, { body: Uint8Array; etag: string }>();
  const calls: string[] = [];
  let n = 0;
  const store: VaultStore = {
    async get(key) {
      calls.push(`get ${key}`);
      return objects.get(key) ?? null;
    },
    async put(key, body, cond) {
      calls.push(`put ${key}`);
      const cur = objects.get(key);
      if ('ifNoneMatch' in cond ? cur : !cur || cur.etag !== cond.ifMatch) throw new PreconditionFailedError();
      const etag = `"etag-${++n}"`;
      objects.set(key, { body, etag });
      return { etag };
    },
  };
  return { store, objects, calls };
}

function event(opts: {
  method: 'GET' | 'PUT' | 'DELETE';
  sub?: string | undefined;
  body?: Uint8Array;
  headers?: Record<string, string>;
  base64?: boolean;
  path?: string;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    version: '2.0',
    routeKey: `${opts.method} /api/vault`,
    rawPath: opts.path ?? '/api/vault',
    rawQueryString: '',
    headers: opts.headers ?? {},
    isBase64Encoded: opts.base64 ?? true,
    body: opts.body ? Buffer.from(opts.body).toString('base64') : undefined,
    requestContext: {
      http: { method: opts.method, path: opts.path ?? '/api/vault', protocol: 'HTTP/1.1', sourceIp: '0.0.0.0', userAgent: 'test' },
      authorizer: { principalId: '', integrationLatency: 0, jwt: { claims: opts.sub === undefined ? {} : { sub: opts.sub }, scopes: [] } },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

const bytes = (s: string) => new TextEncoder().encode(s);

function setup() {
  const m = memoryStore();
  const logs: Record<string, unknown>[] = [];
  const handler = createHandler(m.store, (r) => logs.push(r));
  return { ...m, logs, handler };
}

describe('vaultKey', () => {
  it('sub から保存先を作る', () => {
    expect(vaultKey(ALICE)).toBe(`vaults/${ALICE}/vault.kdbx`);
  });
  it.each(['', '../x', `${ALICE}/../${BOB}`, 'ALICE', `${ALICE} `])('不正な sub を拒否する: %j', (s) => {
    expect(() => vaultKey(s)).toThrow();
  });
});

describe('保存先は必ずトークンの sub から作られる', () => {
  it('パスやヘッダーに他人の ID を入れても、自分の保管庫にしか触れない', async () => {
    const { handler, calls } = setup();
    await handler(event({ method: 'PUT', sub: ALICE, body: bytes('a'), headers: { 'if-none-match': '*', 'x-user': BOB }, path: `/api/vault/${BOB}` }));
    await handler(event({ method: 'GET', sub: ALICE, path: `/api/vault?user=${BOB}` }));
    expect(calls).toEqual([`put vaults/${ALICE}/vault.kdbx`, `get vaults/${ALICE}/vault.kdbx`]);
  });

  it('別の利用者は他人の保管庫を読めない（自分の保管庫がなければ 404）', async () => {
    const { handler } = setup();
    expect((await handler(event({ method: 'PUT', sub: ALICE, body: bytes('a'), headers: { 'if-none-match': '*' } }))).statusCode).toBe(201);
    expect((await handler(event({ method: 'GET', sub: BOB }))).statusCode).toBe(404);
  });

  it('sub がない・不正なら 401 で、ストアに触れない', async () => {
    const { handler, calls } = setup();
    expect((await handler(event({ method: 'GET', sub: undefined }))).statusCode).toBe(401);
    expect((await handler(event({ method: 'GET', sub: '../etc' }))).statusCode).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe('GET /api/vault', () => {
  it('未作成なら 404', async () => {
    const { handler } = setup();
    expect((await handler(event({ method: 'GET', sub: ALICE }))).statusCode).toBe(404);
  });

  it('作成済みならバイナリと ETag を返す', async () => {
    const { handler } = setup();
    await handler(event({ method: 'PUT', sub: ALICE, body: bytes('kdbx'), headers: { 'if-none-match': '*' } }));
    const res = await handler(event({ method: 'GET', sub: ALICE }));
    expect(res.statusCode).toBe(200);
    expect(res.isBase64Encoded).toBe(true);
    expect(Buffer.from(res.body!, 'base64').toString()).toBe('kdbx');
    expect(res.headers?.['etag']).toBe('"etag-1"');
    expect(res.headers?.['cache-control']).toBe('no-store');
  });
});

describe('PUT /api/vault', () => {
  it('新規作成は 201、すでにあれば 412', async () => {
    const { handler } = setup();
    const create = () => handler(event({ method: 'PUT', sub: ALICE, body: bytes('v1'), headers: { 'if-none-match': '*' } }));
    const r1 = await create();
    expect(r1.statusCode).toBe(201);
    expect(r1.headers?.['etag']).toBe('"etag-1"');
    expect((await create()).statusCode).toBe(412);
  });

  it('同じ ETag で2回保存すると2回目は 412', async () => {
    const { handler, objects } = setup();
    await handler(event({ method: 'PUT', sub: ALICE, body: bytes('v1'), headers: { 'if-none-match': '*' } }));
    const save = (s: string) => handler(event({ method: 'PUT', sub: ALICE, body: bytes(s), headers: { 'if-match': '"etag-1"' } }));
    const r2 = await save('v2');
    expect(r2.statusCode).toBe(200);
    expect(r2.headers?.['etag']).toBe('"etag-2"');
    expect((await save('v2-stale')).statusCode).toBe(412);
    expect(Buffer.from(objects.get(vaultKey(ALICE))!.body).toString()).toBe('v2');
  });

  it('未作成の保管庫に If-Match で保存すると 412', async () => {
    const { handler } = setup();
    expect((await handler(event({ method: 'PUT', sub: ALICE, body: bytes('x'), headers: { 'if-match': '"nope"' } }))).statusCode).toBe(412);
  });

  it('条件なしの上書きは 428', async () => {
    const { handler, calls } = setup();
    expect((await handler(event({ method: 'PUT', sub: ALICE, body: bytes('x') }))).statusCode).toBe(428);
    expect(calls).toEqual([]);
  });

  it('If-Match と If-None-Match の両方、または If-None-Match が * 以外なら 400', async () => {
    const { handler } = setup();
    expect((await handler(event({ method: 'PUT', sub: ALICE, body: bytes('x'), headers: { 'if-match': '"a"', 'if-none-match': '*' } }))).statusCode).toBe(400);
    expect((await handler(event({ method: 'PUT', sub: ALICE, body: bytes('x'), headers: { 'if-none-match': '"a"' } }))).statusCode).toBe(400);
  });

  it('上限ちょうどは受け付け、1 バイトでも超えたら 413', async () => {
    const { handler } = setup();
    const at = await handler(event({ method: 'PUT', sub: ALICE, body: new Uint8Array(MAX_VAULT_BYTES), headers: { 'if-none-match': '*' } }));
    expect(at.statusCode).toBe(201);
    const over = await handler(event({ method: 'PUT', sub: BOB, body: new Uint8Array(MAX_VAULT_BYTES + 1), headers: { 'if-none-match': '*' } }));
    expect(over.statusCode).toBe(413);
  });

  it('空の本文は 400、Base64 でない本文は 415', async () => {
    const { handler } = setup();
    expect((await handler(event({ method: 'PUT', sub: ALICE, body: new Uint8Array(0), headers: { 'if-none-match': '*' } }))).statusCode).toBe(400);
    expect((await handler(event({ method: 'PUT', sub: ALICE, body: bytes('x'), headers: { 'if-none-match': '*' }, base64: false }))).statusCode).toBe(415);
  });
});

describe('その他', () => {
  it('GET と PUT 以外は 405', async () => {
    const { handler } = setup();
    expect((await handler(event({ method: 'DELETE', sub: ALICE }))).statusCode).toBe(405);
  });

  it('ストアの想定外のエラーは 500 にし、詳細を返さない', async () => {
    const store: VaultStore = { get: async () => { throw new Error('boom secret'); }, put: async () => { throw new Error('x'); } };
    const logs: Record<string, unknown>[] = [];
    const res = await createHandler(store, (r) => logs.push(r))(event({ method: 'GET', sub: ALICE }));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('boom');
    expect(JSON.stringify(logs)).not.toContain('boom');
  });

  it('ログに本文・トークン関連の値を出さない', async () => {
    const { handler, logs } = setup();
    const secret = 'TOP-SECRET-CONTENT';
    await handler(event({ method: 'PUT', sub: ALICE, body: bytes(secret), headers: { 'if-none-match': '*', authorization: 'Bearer SECRET-TOKEN' } }));
    await handler(event({ method: 'GET', sub: ALICE }));
    const all = JSON.stringify(logs);
    expect(all).not.toContain(secret);
    expect(all).not.toContain(Buffer.from(secret).toString('base64'));
    expect(all).not.toContain('SECRET-TOKEN');
    expect(logs.every((l) => Object.keys(l).every((k) => ['level', 'sub', 'method', 'status', 'bytes', 'ms', 'error'].includes(k)))).toBe(true);
  });
});
