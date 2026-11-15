export type AppConfig = {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  cognitoDomain: string;
  /** `npm run dev` の模擬 API のときだけ true。本番の config.json には含まれない */
  dev?: boolean;
};

export async function loadConfig(): Promise<AppConfig> {
  const res = await fetch('/config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`config.json: ${res.status}`);
  return (await res.json()) as AppConfig;
}
