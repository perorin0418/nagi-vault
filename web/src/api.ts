// 保管庫 API（HANDOFF 3.3）。本文は暗号化済みの kdbx バイナリだけ。
import { getAccessToken } from './auth';

export const MAX_VAULT_BYTES = 4 * 1024 * 1024;

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

function fail(res: Response): never {
  if (res.status === 401) throw new AuthRequiredError(401, 'ログインの有効期限が切れました。');
  if (res.status === 412) throw new ConflictError(412, '別の端末で先に保存されています。');
  if (res.status === 413) throw new ApiError(413, `保管庫が上限（${MAX_VAULT_BYTES / 1024 / 1024} MiB）を超えています。`);
  if (res.status === 429) throw new ApiError(429, '要求が多すぎます。少し待ってからやり直してください。');
  throw new ApiError(res.status, `サーバーエラー（${res.status}）`);
}

/** 保管庫を取得する。未作成なら null */
export async function fetchVault(): Promise<{ bytes: Uint8Array; etag: string } | null> {
  const res = await fetch('/api/vault', { headers: await authHeaders(), cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) fail(res);
  const etag = res.headers.get('etag');
  if (!etag) throw new ApiError(res.status, 'ETag がありません');
  return { bytes: new Uint8Array(await res.arrayBuffer()), etag };
}

/** 保管庫を保存する。etag が null なら新規作成 */
export async function storeVault(bytes: Uint8Array, etag: string | null): Promise<string> {
  const res = await fetch('/api/vault', {
    method: 'PUT',
    headers: {
      ...(await authHeaders()),
      'content-type': 'application/octet-stream',
      ...(etag ? { 'if-match': etag } : { 'if-none-match': '*' }),
    },
    body: bytes as BodyInit,
  });
  if (!res.ok) fail(res);
  const newEtag = res.headers.get('etag');
  if (!newEtag) throw new ApiError(res.status, 'ETag がありません');
  return newEtag;
}
