// Phase 1 の仮の画面。Phase 3 でログインと保管庫の操作を実装する。
type AppConfig = { region: string; userPoolId: string; userPoolClientId: string; cognitoDomain: string };

async function main() {
  const status = document.getElementById('status')!;
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`config.json: ${res.status}`);
    const config = (await res.json()) as AppConfig;
    status.textContent = `配信は正常です（リージョン ${config.region}）。画面は Phase 3 で実装します。`;
  } catch {
    status.textContent = '設定ファイルを読み込めませんでした。';
  }
}

void main();
