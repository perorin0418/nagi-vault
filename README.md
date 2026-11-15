# nagi-vault

AWS のサーバーレス構成で動く、ブラウザ用のパスワード保管庫。保管庫は kdbx 形式のファイル1つで、暗号化・復号はブラウザの中だけで行う。保管庫ファイルは署名付き URL でブラウザと S3 の間を直接やり取りし、上限は 64 MiB（[docs/verification.md](docs/verification.md) 5 章）。

- 引継ぎ作業書：[HANDOFF.md](HANDOFF.md)
- 構成図：[docs/aws-vault-architecture.html](docs/aws-vault-architecture.html)
- Phase 0 技術検証の記録：[docs/verification.md](docs/verification.md)

## 進捗

- [x] Phase 0：技術検証（鍵導出の設定値のみ Phase 3 でブラウザ実測して確定）
- [x] Phase 1：インフラ（CDK）— 開発環境 `NagiVault-dev` をデプロイ済み
- [x] Phase 2：API（Lambda）— 実トークンでの確認は Phase 3 で行う
- [x] Phase 3：画面（ローカルと開発環境で確認済み。署名付き URL 方式を追加）
- [ ] Phase 4：運用設定と仕上げ

## 構成

| ディレクトリ | 内容 |
|---|---|
| `web/` | 画面（Vite + TypeScript）。`npm run dev -w web` で模擬 API を使ってログインなしで動かせる |
| `api/` | Lambda（保管庫の有無の確認と、署名付き URL の発行）。`npm test` で単体テスト |
| `infra/` | AWS CDK。`AWS_PROFILE=... NAGI_VAULT_BUDGET_EMAIL=... npm run deploy` |
| `verification/` | Phase 0 などの技術検証スクリプト |
| `scripts/` | デプロイ後の確認スクリプト |
