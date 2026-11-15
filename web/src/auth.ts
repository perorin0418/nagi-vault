// Cognito マネージドログイン（認可コードフロー + PKCE）
//
// - アクセストークン・リフレッシュトークンはメモリにだけ置く（HANDOFF 3.4）。再読み込みすると再ログインになる。
// - リダイレクトをまたいで必要な code_verifier と state だけを sessionStorage に置き、使ったらすぐ消す。
import type { AppConfig } from './config';

type Tokens = { accessToken: string; idToken: string; refreshToken?: string; expiresAt: number };

const PENDING_KEY = 'nagi-vault.pkce';

let tokens: Tokens | null = null;
let config: AppConfig;

const redirectUri = () => `${location.origin}/`;

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(len = 48): string {
  return base64url(crypto.getRandomValues(new Uint8Array(len)));
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export function initAuth(c: AppConfig) {
  config = c;
}

/** マネージドログインの画面へ移動する */
export async function login(): Promise<never> {
  const verifier = randomString();
  const state = randomString(24);
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ verifier, state }));
  const url = new URL(`https://${config.cognitoDomain}/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.userPoolClientId,
    redirect_uri: redirectUri(),
    scope: 'openid email',
    state,
    code_challenge: base64url(await sha256(verifier)),
    code_challenge_method: 'S256',
  }).toString();
  location.assign(url.toString());
  return new Promise<never>(() => {});
}

export function logout(): never {
  tokens = null;
  const url = new URL(`https://${config.cognitoDomain}/logout`);
  url.search = new URLSearchParams({ client_id: config.userPoolClientId, logout_uri: redirectUri() }).toString();
  location.assign(url.toString());
  throw new Error('redirecting');
}

async function tokenRequest(params: Record<string, string>): Promise<Tokens> {
  const res = await fetch(`https://${config.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.userPoolClientId, ...params }).toString(),
  });
  if (!res.ok) throw new Error(`token endpoint: ${res.status}`);
  const j = (await res.json()) as { access_token: string; id_token: string; refresh_token?: string; expires_in: number };
  return {
    accessToken: j.access_token,
    idToken: j.id_token,
    refreshToken: j.refresh_token ?? params['refresh_token'],
    expiresAt: Date.now() + j.expires_in * 1000,
  };
}

/**
 * ログインから戻ってきた場合はコードをトークンに交換する。
 * 戻り値: ログイン済みなら true
 */
export async function handleRedirect(): Promise<boolean> {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (!code && !error) return tokens !== null;

  // URL からコードを消す（履歴やリファラーに残さない）
  history.replaceState(null, '', '/');
  const pendingRaw = sessionStorage.getItem(PENDING_KEY);
  sessionStorage.removeItem(PENDING_KEY);
  if (error) throw new Error(`ログインに失敗しました（${error}）`);
  const pending = pendingRaw ? (JSON.parse(pendingRaw) as { verifier: string; state: string }) : null;
  if (!pending || pending.state !== params.get('state')) throw new Error('ログインの状態が一致しません。もう一度ログインしてください。');

  tokens = await tokenRequest({ grant_type: 'authorization_code', code: code!, redirect_uri: redirectUri(), code_verifier: pending.verifier });
  return true;
}

/** 有効なアクセストークンを返す。期限が近ければリフレッシュする */
export async function getAccessToken(): Promise<string | null> {
  if (!tokens) return null;
  if (Date.now() > tokens.expiresAt - 60_000) {
    if (!tokens.refreshToken) return null;
    try {
      tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
    } catch {
      tokens = null;
      return null;
    }
  }
  return tokens.accessToken;
}

/** 表示用のメールアドレス（ID トークンの中身。署名の検証はしていないので表示にだけ使う） */
export function userEmail(): string | null {
  if (!tokens) return null;
  try {
    const payload = tokens.idToken.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)));
    return (JSON.parse(json) as { email?: string }).email ?? null;
  } catch {
    return null;
  }
}
