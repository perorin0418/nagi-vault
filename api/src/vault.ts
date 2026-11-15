// 保管庫 API の本体。S3 クライアントは注入できるようにして、単体テストで差し替える。
//
// セキュリティ上の約束（HANDOFF 3.3 / 3.4）:
// - 保存先のキーはトークンの sub クレームからだけ組み立てる。リクエストの値は使わない。
// - リクエスト本文や保管庫の中身、トークンはログに出さない。
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

/** 保管庫の大きさの上限（docs/verification.md 4 章で決定） */
export const MAX_VAULT_BYTES = 4 * 1024 * 1024;

/** Cognito の sub は UUID 形式 */
const SUB_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function vaultKey(sub: string): string {
  if (!SUB_PATTERN.test(sub)) throw new Error('invalid sub');
  return `vaults/${sub}/vault.kdbx`;
}

/** 必要な S3 操作だけを抜き出した口。本番は @aws-sdk/client-s3 をこれに合わせて包む */
export interface VaultStore {
  get(key: string): Promise<{ body: Uint8Array; etag: string } | null>;
  /** 条件が合わなければ PreconditionFailedError を投げる */
  put(key: string, body: Uint8Array, cond: { ifMatch: string } | { ifNoneMatch: '*' }): Promise<{ etag: string }>;
}

export class PreconditionFailedError extends Error {
  constructor() {
    super('precondition failed');
    this.name = 'PreconditionFailedError';
  }
}

export type Logger = (record: Record<string, string | number | boolean>) => void;

type Result = APIGatewayProxyStructuredResultV2;

const BASE_HEADERS = { 'cache-control': 'no-store' };

function json(statusCode: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Result {
  return { statusCode, headers: { ...BASE_HEADERS, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

function header(event: APIGatewayProxyEventV2WithJWTAuthorizer, name: string): string | undefined {
  // HTTP API（ペイロード 2.0）はヘッダー名を小文字にして渡す
  return event.headers?.[name];
}

export function createHandler(store: VaultStore, log: Logger = (r) => console.log(JSON.stringify(r))) {
  return async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<Result> {
    const started = Date.now();
    const method = event.requestContext.http.method;
    const sub = event.requestContext.authorizer?.jwt?.claims?.['sub'];
    let result: Result;
    let bytes = 0;

    try {
      if (typeof sub !== 'string' || !SUB_PATTERN.test(sub)) {
        // JWT オーソライザーを通っていれば起きないはずだが、念のため拒否する
        result = json(401, { error: 'unauthorized' });
      } else if (method === 'GET') {
        const obj = await store.get(vaultKey(sub));
        if (!obj) {
          result = json(404, { error: 'vault not found' });
        } else {
          bytes = obj.body.byteLength;
          result = {
            statusCode: 200,
            isBase64Encoded: true,
            headers: { ...BASE_HEADERS, 'content-type': 'application/octet-stream', etag: obj.etag },
            body: Buffer.from(obj.body).toString('base64'),
          };
        }
      } else if (method === 'PUT') {
        result = await handlePut(event, sub, store, (n) => (bytes = n));
      } else {
        result = json(405, { error: 'method not allowed' }, { allow: 'GET, PUT' });
      }
    } catch (err) {
      // エラーの詳細（メッセージ）には本文が含まれないが、念のため名前だけ記録する
      log({ level: 'error', error: err instanceof Error ? err.name : 'unknown' });
      result = json(500, { error: 'internal error' });
    }

    log({
      level: 'info',
      sub: typeof sub === 'string' ? sub : 'none',
      method,
      status: result.statusCode ?? 0,
      bytes,
      ms: Date.now() - started,
    });
    return result;
  };
}

async function handlePut(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  sub: string,
  store: VaultStore,
  setBytes: (n: number) => void,
): Promise<Result> {
  const ifMatch = header(event, 'if-match');
  const ifNoneMatch = header(event, 'if-none-match');
  if (ifMatch && ifNoneMatch) return json(400, { error: 'specify only one of If-Match or If-None-Match' });
  if (ifNoneMatch !== undefined && ifNoneMatch !== '*') return json(400, { error: 'If-None-Match must be *' });
  // 条件なしの上書きは受け付けない（他の端末の保存を消してしまうため）
  if (!ifMatch && !ifNoneMatch) return json(428, { error: 'If-Match or If-None-Match: * is required' });

  if (!event.isBase64Encoded) return json(415, { error: 'body must be application/octet-stream' });
  const body = Buffer.from(event.body ?? '', 'base64');
  setBytes(body.byteLength);
  if (body.byteLength === 0) return json(400, { error: 'empty body' });
  if (body.byteLength > MAX_VAULT_BYTES) return json(413, { error: 'vault too large', maxBytes: MAX_VAULT_BYTES });

  const creating = !ifMatch;
  try {
    const { etag } = await store.put(vaultKey(sub), body, creating ? { ifNoneMatch: '*' } : { ifMatch: ifMatch! });
    return json(creating ? 201 : 200, { etag }, { etag });
  } catch (err) {
    if (err instanceof PreconditionFailedError) {
      return json(412, { error: creating ? 'vault already exists' : 'vault was updated by another session' });
    }
    throw err;
  }
}
