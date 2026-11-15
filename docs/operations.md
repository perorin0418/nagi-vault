# nagi-vault 運用手順

開発環境 `NagiVault-dev`（us-east-1）を前提に書く。別の環境を作るときは、`-c env=<名前>` を付けてデプロイし、手順中のスタック名 `NagiVault-dev` を読み替える。

コマンドは Git Bash で動かす前提。Git Bash は `/aws/lambda/...` のような引数を Windows のパスに書き換えてしまうので、先に `export MSYS_NO_PATHCONV=1` を実行しておく。

```bash
export AWS_PROFILE=nagi-vault
export MSYS_NO_PATHCONV=1
STACK=NagiVault-dev
out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
POOL=$(out UserPoolId)
VAULT_BUCKET=$(out VaultBucketName)
```

## 1. 構成のおさらい

| 項目 | 確認方法 |
|---|---|
| 画面の URL | `out AppUrl` |
| Cognito のユーザープール | `out UserPoolId` |
| 保管庫用バケット | `out VaultBucketName`（保管庫は `vaults/<利用者の sub>/vault.kdbx`） |
| Lambda のログ | CloudWatch Logs の `NagiVault-dev-VaultFnLogs...`（14 日で削除） |
| 費用の通知 | AWS Budgets `nagi-vault-dev-monthly`（月 1 ドル超でメール） |

サーバー側にあるのは暗号化済みの kdbx ファイルだけで、管理者も中身を読めない。**マスターパスワードを忘れた保管庫は、誰にも復旧できない。**

## 2. デプロイ

前提：Node.js 24、AWS CLI、`nagi-vault` プロファイルで管理者権限があること。

```bash
npm ci
npm test                       # API の単体テスト
npm run typecheck
cd infra
# 初めてのアカウント・リージョンだけ
npx cdk bootstrap
# 費用通知の送り先はリポジトリに書かず、ここで渡す
NAGI_VAULT_BUDGET_EMAIL=<通知先アドレス> npm run deploy   # 画面をビルドしてから cdk deploy する
```

- デプロイの前に `npx cdk diff` で変更内容を確認する。**保管庫用バケット（VaultBucket）が `replace` になる変更は要注意**（中身は自動では移らない。旧バケットは Retain で残るので、移行してから消す）。
- 月額固定料金のかかるリソースを追加しない（HANDOFF 2 章）。
- デプロイ後の確認：`node scripts/e2e-lambda.mjs NagiVault-dev`（利用者の分離・条件付き保存・上限を、実際の Lambda と S3 で確かめる。テスト用データは自動で消える）。

## 3. 利用者の管理

自己登録は無効なので、利用者は管理者が作る。利用者のログイン名はメールアドレス。

### 追加

```bash
aws cognito-idp admin-create-user --user-pool-id "$POOL" \
  --username <メールアドレス> \
  --user-attributes Name=email,Value=<メールアドレス> Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL
```

仮パスワードは Cognito から本人にメールで届く（管理者は見ない）。本人に次を伝える。

1. 画面の URL を開いて「ログイン」→ 仮パスワードでログイン → 新しいパスワードを設定（12 文字以上、大文字・小文字・数字を含む）。
2. 認証アプリ（Google Authenticator、Microsoft Authenticator など）で TOTP を登録する（必須）。
3. 保管庫を作る。**マスターパスワードはログインのパスワードと別のものにし、忘れないよう控える。**
4. 定期的に「ダウンロード」で保管庫ファイルを手元に保存する（5 章）。

仮パスワードの有効期限は 7 日。切れたら同じコマンドに `--message-action RESEND` を付けて送り直す。

### 利用者 ID（sub）を調べる

保管庫の場所は `vaults/<sub>/vault.kdbx`。このプールでは利用者名（Username）が sub と同じ。

```bash
aws cognito-idp list-users --user-pool-id "$POOL" --filter 'email = "<メールアドレス>"' \
  --query 'Users[].[Username,UserStatus,Enabled]' --output text
```

### ログインのパスワードを忘れた

```bash
aws cognito-idp admin-reset-user-password --user-pool-id "$POOL" --username <メールアドレス>
```

本人にリセット用のコードがメールで届き、次のログインで新しいパスワードを設定する。保管庫のマスターパスワードとは無関係（こちらは復旧できない）。

### 認証アプリ（TOTP）をなくした

```bash
aws cognito-idp admin-set-user-mfa-preference --user-pool-id "$POOL" --username <メールアドレス> \
  --software-token-mfa-settings Enabled=false,PreferredMfa=false
```

MFA は必須なので、次のログインで TOTP の登録をやり直す画面になる想定。**この手順は未検証**（実際の利用者で試していない）。初めて使うときは、テスト用の利用者で動作を確かめてから本人に案内する。

補足：`admin-get-user` の `UserMFASettingList` には、マネージドログインで登録した TOTP が表示されないことがある。実際に TOTP が求められているかは CloudTrail で確かめられる（パスワードでのログイン `login_POST` の直後に `mfa_totp_POST` がある）。

```bash
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventSource,AttributeValue=cognito-idp.amazonaws.com \
  --max-results 50 --query 'Events[].[EventTime,EventName]' --output text
```

`OAuth2_Authorize_GET` の直後に `Token_POST` だけがあるのは、Cognito のドメインに残っているログイン状態（クッキー）を使った再ログインで、パスワードと TOTP は求められない。共用の PC ではログアウトしてからブラウザを閉じるよう案内する。

### 一時的に止める・削除する

```bash
aws cognito-idp admin-disable-user --user-pool-id "$POOL" --username <メールアドレス>   # 止める（enable で戻せる）
aws cognito-idp admin-user-global-sign-out --user-pool-id "$POOL" --username <メールアドレス>  # 発行済みのリフレッシュトークンを無効化
aws cognito-idp admin-delete-user --user-pool-id "$POOL" --username <メールアドレス>    # 削除（元に戻せない）
```

止めても、発行済みのアクセストークンは期限（1 時間）まで使える。急ぐときは disable と global-sign-out を両方行う。

利用者を削除しても保管庫ファイルは残る。不要なら、本人に最新版をダウンロードしてもらってから消す（全バージョン）：

```bash
SUB=<sub>
aws s3api list-object-versions --bucket "$VAULT_BUCKET" --prefix "vaults/$SUB/" \
  --query '{Objects: [Versions[], DeleteMarkers[]][].{Key:Key,VersionId:VersionId}}' --output json > /tmp/del.json
aws s3api delete-objects --bucket "$VAULT_BUCKET" --delete file:///tmp/del.json
```

## 4. 監視

- **費用**：月 1 ドルを超えると通知先にメールが届く。現状の見込みはほぼ 0 ドル（保管料が数円程度）。大きな保管庫を頻繁に保存すると、古い版（90 日保持）の保管料が増える（`docs/verification.md` 5 章）。
- **ログ**：Lambda は 1 リクエストにつき 1 行、`level / sub / method / path / status / bytes / ms`（エラー時は `error` に種類だけ）を出す。本文・署名付き URL・ETag・トークンは出さない。

  ```bash
  LG=$(aws logs describe-log-groups --query "logGroups[?contains(logGroupName,'VaultFnLogs')].logGroupName" --output text)
  aws logs tail "$LG" --since 1d --format short | grep '"level"'
  aws logs filter-log-events --log-group-name "$LG" --filter-pattern '{ $.level = "error" }' --query 'events[].message' --output text
  ```

- **流量制限**：API は毎秒 5 件（バースト 10）。超えると画面に「要求が多すぎます」と出る。

## 5. バックアップと復元

保管庫はブラウザの中で暗号化された kdbx ファイルなので、どこにコピーしても中身は読まれない。ただし、開くにはマスターパスワードが必要。

### 利用者自身のバックアップ（推奨）

画面の「ダウンロード」で `nagi-vault-YYYYMMDD.kdbx` を保存する。**KeePassXC などの KeePass 系ソフトで、そのまま開ける。** サービスが使えなくなっても、このファイルとマスターパスワードがあれば中身を取り出せる。

### S3 の古い版

保管庫用バケットはバージョニングが有効で、上書き前の版を **90 日** 残す。

```bash
SUB=<sub>
aws s3api list-object-versions --bucket "$VAULT_BUCKET" --prefix "vaults/$SUB/vault.kdbx" \
  --query 'Versions[].[VersionId,LastModified,Size,IsLatest]' --output table
```

### 古い版に戻す

1. **本人に、開いている画面をすべてロックしてもらう**（開いたままの画面で保存すると、古い版に戻した後で新しい内容がマージされて戻ってしまう）。
2. 戻したい版を、同じ場所にコピーして最新版にする（元の最新版も古い版として残るので、やり直せる）。

   ```bash
   aws s3api copy-object --bucket "$VAULT_BUCKET" --key "vaults/$SUB/vault.kdbx" \
     --copy-source "$VAULT_BUCKET/vaults/$SUB/vault.kdbx?versionId=<VersionId>" \
     --content-type application/octet-stream --metadata-directive REPLACE
   ```

3. 本人に画面を再読み込みして開いてもらう。

### ダウンロードしたファイルから戻す

画面には取り込み機能がないので、管理者が置き直す。上と同じく、先に本人の画面をロックしてもらう。

```bash
aws s3 cp nagi-vault-YYYYMMDD.kdbx "s3://$VAULT_BUCKET/vaults/$SUB/vault.kdbx" --content-type application/octet-stream
```

マスターパスワードはファイルを作ったときのものになる。

### 管理者による一括バックアップ

```bash
aws s3 sync "s3://$VAULT_BUCKET/vaults/" ./vault-backup/vaults/
```

中身は暗号化済みだが、利用者ごとのマスターパスワードの強さに依存するので、保管場所は慎重に選ぶ。

### 中身を確かめる（KeePassXC を入れずに）

ファイルが壊れていないかは、使い捨てのコンテナで KeePassXC のコマンド版を動かして確かめられる。マスターパスワードは本人が入力する。

```bash
cd verification
./open-in-keepassxc.sh <kdbx ファイルのパス>
```

## 6. 障害時

| 症状 | 対応 |
|---|---|
| 画面が開かない | CloudFront と画面配信用 S3 を確認。`npm run deploy` で配信し直せる |
| ログインできない | Cognito の状態、利用者が disable になっていないか、仮パスワードの期限切れを確認 |
| 保存で「別の端末で先に保存されています」が続く | 自動マージを 3 回試して失敗している。画面を再読み込みして開き直す |
| 「マスターパスワードが違います」 | マスターパスワードの入力違い。忘れた場合は復旧できない |
| 保管庫が壊れた・誤って消した | 5 章の「古い版に戻す」 |
| AWS 側が使えない | ダウンロードしておいたファイルを KeePassXC で開く |

## 7. 環境の削除

```bash
cd infra && NAGI_VAULT_BUDGET_EMAIL=<通知先> npx cdk destroy
```

- 保管庫用バケットは **残る**（Retain）。中身が不要と確認できたら手動で全バージョンを消してからバケットを消す。
- Cognito のユーザープールは削除される（利用者もすべて消える）。
- CDK のブートストラップ（`CDKToolkit` スタック）は残る。不要なら CloudFormation から削除する。

## 8. 依存パッケージの更新

- バージョンは固定（`.npmrc` の `save-exact=true`）し、`package-lock.json` をコミットする。
- **公開から 14 日未満のバージョンは採用しない**（HANDOFF 3.4）。
- kdbxweb の依存 `@xmldom/xmldom` は、ルートの `package.json` の `overrides` で修正版に固定している。画面のバンドルからはスタブで除外している（`web/vite.config.ts`）。
- 更新したら `npm test`、`npm run typecheck`、`npm run build`、`npm audit` を実行し、`verification/` の検証（`npm run all`）も通ることを確かめる。

## 9. 秘密情報

次のものはリポジトリに書かない：AWS のアカウント ID、費用通知のメールアドレス、利用者の情報、認証情報。`cdk.context.json` と `cdk.out/` は `.gitignore` 済み。
