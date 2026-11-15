// 保管庫 API（docs/verification.md 5 章）
//
// 保管庫ファイルは Lambda を通さず、API が発行する署名付き URL を使って S3 と直接やり取りする。
// 送るのは暗号化済みの kdbx だけ。
import { getAccessToken } from './auth';

/** 保管庫の大きさの上限。サーバーの応答で上書きする */
export let MAX_VAULT_BYTES = 64 * 1024 * 1024;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export class ConflictError extends ApiError {}
export class AuthRequiredError extends ApiError {}

let devMode = false;
export function setDevMode(v: boolean) {
  devMode = v;
}

async function authHeaders(): Promise<Record<string, string>> {
  if (import.meta.env.DEV && devMode) return {};
  const token = await getAccessToken();
  if (!token) throw new AuthRequiredError(401, 'ログインの有効期限が切れました。');
  return { authorization: `Bearer ${token}` };
}

const mib = (n: number) => `${Math.round(n / 1024 / 1024)} MiB`;

function apiFail(res: Response): never {
  if (res.status === 401) throw new AuthRequiredError(401, 'ログインの有効期限が切れました。');
  if (res.status === 413) throw new ApiError(413, `保管庫が上限（${mib(MAX_VAULT_BYTES)}）を超えています。`);
  if (res.status === 429) throw new ApiError(429, '要求が多すぎます。少し待ってからやり直してください。');
  throw new ApiError(res.status, `サーバーエラー（${res.status}）`);
}

/** 保管庫を取得する。未作成なら null */
export async function fetchVault(): Promise<{ bytes: Uint8Array; etag: string } | null> {
  const res = await fetch('/api/vault', { headers: await authHeaders(), cache: 'no-store' });
  if (res.status === 404) {
    const j = (await res.json().catch(() => ({}))) as { maxBytes?: number };
    if (j.maxBytes) MAX_VAULT_BYTES = j.maxBytes;
    return null;
  }
  if (!res.ok) apiFail(res);
  const meta = (await res.json()) as { downloadUrl: string; maxBytes: number };
  MAX_VAULT_BYTES = meta.maxBytes;

  // S3 から直接取得。ETag は実際に受け取った版のものを使う（取得の間に別の端末が保存しても食い違わない）
  const file = await fetch(meta.downloadUrl, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!file.ok) throw new ApiError(file.status, `保管庫を取得できませんでした（${file.status}）`);
  const etag = file.headers.get('etag');
  if (!etag) throw new ApiError(file.status, 'ETag を読み取れませんでした');
  return { bytes: new Uint8Array(await file.arrayBuffer()), etag };
}

/** 保管庫を保存する。etag が null なら新規作成。新しい ETag を返す */
export async function storeVault(bytes: Uint8Array, etag: string | null): Promise<string> {
  if (bytes.byteLength > MAX_VAULT_BYTES) throw new ApiError(413, `保管庫が上限（${mib(MAX_VAULT_BYTES)}）を超えています。`);

  // 1. 条件と大きさを署名に含めたアップロード用 URL をもらう
  const res = await fetch('/api/vault/upload-url', {
    method: 'POST',
    headers: { ...(await authHeaders()), 'content-type': 'application/json' },
    body: JSON.stringify({ size: bytes.byteLength, ...(etag ? { ifMatch: etag } : { ifNoneMatch: '*' }) }),
  });
  if (!res.ok) apiFail(res);
  const { uploadUrl, headers } = (await res.json()) as { uploadUrl: string; headers: Record<string, string> };

  // 2. S3 に直接送る。条件が合わなければ S3 が 412 を返す
  const put = await fetch(uploadUrl, { method: 'PUT', headers, body: bytes as BodyInit, credentials: 'omit', referrerPolicy: 'no-referrer' });
  // 412: 先に別の版が保存された / 409: 同時に保存された / 404: If-Match の対象が消えている
  if (put.status === 412 || put.status === 409 || put.status === 404) throw new ConflictError(412, '別の端末で先に保存されています。');
  if (put.status === 403) throw new ApiError(403, '保存の許可が期限切れになりました。もう一度保存してください。');
  if (!put.ok) throw new ApiError(put.status, `保存できませんでした（${put.status}）`);
  const newEtag = put.headers.get('etag');
  if (!newEtag) throw new ApiError(put.status, 'ETag を読み取れませんでした');
  return newEtag;
}
