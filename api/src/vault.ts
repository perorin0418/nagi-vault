// 保管庫 API の本体。S3 の操作は注入できるようにして、単体テストで差し替える。
//
// 保管庫ファイルそのものは Lambda を通さず、ブラウザと S3 の間で署名付き URL を使って直接やり取りする
// （Lambda の 6 MB 制限を避けるため。docs/verification.md 5 章）。Lambda は次だけを行う。
// - GET  /api/vault            : 保管庫の有無・ETag・サイズと、ダウンロード用の署名付き URL を返す
// - POST /api/vault/upload-url : 条件（If-Match / If-None-Match）と大きさを署名に含めたアップロード用 URL を返す
//
// セキュリティ上の約束（HANDOFF 3.3 / 3.4）:
// - 保存先のキーはトークンの sub クレームからだけ組み立てる。リクエストの値は使わない。
// - 条件なしの上書きはさせない（条件ヘッダーは署名に含めるので、利用者は外せない）。
// - リクエスト本文やトークンはログに出さない。
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

/** 保管庫の大きさの上限 */
export const MAX_VAULT_BYTES = 64 * 1024 * 1024;
/** 署名付き URL の有効期限（秒） */
export const URL_EXPIRES_SECONDS = 300;

/** Cognito の sub は UUID 形式 */
const SUB_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** S3 の ETag（引用符付き） */
const ETAG_PATTERN = /^"[0-9A-Za-z-]{1,128}"$/;

export function vaultKey(sub: string): string {
  if (!SUB_PATTERN.test(sub)) throw new Error('invalid sub');
  return `vaults/${sub}/vault.kdbx`;
}

export type UploadCondition = { ifMatch: string } | { ifNoneMatch: '*' };

/** 必要な S3 操作だけを抜き出した口 */
export interface VaultStore {
  head(key: string): Promise<{ etag: string; size: number } | null>;
  presignGet(key: string, expiresIn: number): Promise<string>;
  presignPut(key: string, size: number, cond: UploadCondition, expiresIn: number): Promise<string>;
}

export type Logger = (record: Record<string, string | number | boolean>) => void;

type Result = APIGatewayProxyStructuredResultV2;

function json(statusCode: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Result {
  return { statusCode, headers: { 'cache-control': 'no-store', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

export function createHandler(store: VaultStore, log: Logger = (r) => console.log(JSON.stringify(r))) {
  return async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<Result> {
    const started = Date.now();
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    const sub = event.requestContext.authorizer?.jwt?.claims?.['sub'];
    let result: Result;
    let bytes = 0;

    try {
      if (typeof sub !== 'string' || !SUB_PATTERN.test(sub)) {
        // JWT オーソライザーを通っていれば起きないはずだが、念のため拒否する
        result = json(401, { error: 'unauthorized' });
      } else if (path === '/api/vault' && method === 'GET') {
        const key = vaultKey(sub);
        const obj = await store.head(key);
        if (!obj) {
          result = json(404, { error: 'vault not found', maxBytes: MAX_VAULT_BYTES });
        } else {
          bytes = obj.size;
          const downloadUrl = await store.presignGet(key, URL_EXPIRES_SECONDS);
          result = json(200, { etag: obj.etag, size: obj.size, maxBytes: MAX_VAULT_BYTES, downloadUrl });
        }
      } else if (path === '/api/vault/upload-url' && method === 'POST') {
        const r = await uploadUrl(event, sub, store);
        bytes = r.bytes;
        result = r.result;
      } else {
        result = json(404, { error: 'not found' });
      }
    } catch (err) {
      log({ level: 'error', error: err instanceof Error ? err.name : 'unknown' });
      result = json(500, { error: 'internal error' });
    }

    log({ level: 'info', sub: typeof sub === 'string' ? sub : 'none', method, path, status: result.statusCode ?? 0, bytes, ms: Date.now() - started });
    return result;
  };
}

async function uploadUrl(event: APIGatewayProxyEventV2WithJWTAuthorizer, sub: string, store: VaultStore): Promise<{ result: Result; bytes: number }> {
  let req: unknown;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
    if (raw.length > 1024) return { result: json(400, { error: 'request too large' }), bytes: 0 };
    req = JSON.parse(raw);
  } catch {
    return { result: json(400, { error: 'body must be JSON' }), bytes: 0 };
  }
  if (typeof req !== 'object' || req === null) return { result: json(400, { error: 'body must be a JSON object' }), bytes: 0 };
  const { size, ifMatch, ifNoneMatch } = req as Record<string, unknown>;

  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return { result: json(400, { error: 'size must be a positive integer' }), bytes: 0 };
  if (size > MAX_VAULT_BYTES) return { result: json(413, { error: 'vault too large', maxBytes: MAX_VAULT_BYTES }), bytes: size };
  if (ifMatch !== undefined && ifNoneMatch !== undefined) return { result: json(400, { error: 'specify only one of ifMatch or ifNoneMatch' }), bytes: size };
  if (ifMatch === undefined && ifNoneMatch === undefined) return { result: json(428, { error: 'ifMatch or ifNoneMatch: "*" is required' }), bytes: size };
  if (ifNoneMatch !== undefined && ifNoneMatch !== '*') return { result: json(400, { error: 'ifNoneMatch must be "*"' }), bytes: size };
  if (ifMatch !== undefined && (typeof ifMatch !== 'string' || !ETAG_PATTERN.test(ifMatch))) return { result: json(400, { error: 'invalid ifMatch' }), bytes: size };

  const cond: UploadCondition = ifMatch !== undefined ? { ifMatch: ifMatch as string } : { ifNoneMatch: '*' };
  const uploadUrl = await store.presignPut(vaultKey(sub), size, cond, URL_EXPIRES_SECONDS);
  // ブラウザが S3 に送るときに付けるヘッダー（署名に含まれているので、変えると 403 になる）
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    ...('ifMatch' in cond ? { 'if-match': cond.ifMatch } : { 'if-none-match': '*' }),
  };
  return { result: json(200, { uploadUrl, headers, expiresIn: URL_EXPIRES_SECONDS }), bytes: size };
}
