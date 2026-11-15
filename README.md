# nagi-vault

AWS のサーバーレス構成で動く、ブラウザ用のパスワード保管庫。保管庫は kdbx 形式のファイル1つで、暗号化・復号はブラウザの中だけで行う。

- 引継ぎ作業書：[HANDOFF.md](HANDOFF.md)
- 構成図：[docs/aws-vault-architecture.html](docs/aws-vault-architecture.html)
- Phase 0 技術検証の記録：[docs/verification.md](docs/verification.md)

## 進捗

- [x] Phase 0：技術検証（一部未完了。KeePassXC 確認と AWS 上の検証が残っている）
- [ ] Phase 1：インフラ（CDK）
- [ ] Phase 2：API（Lambda）
- [ ] Phase 3：画面
- [ ] Phase 4：運用設定と仕上げ
