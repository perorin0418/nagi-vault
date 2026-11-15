# Phase 0 技術検証の記録

HANDOFF.md「4. 作業手順 Phase 0」の結果を記録する。検証コードは `verification/` にある。

- 実施日：2026-11-15
- 実施環境：Windows 11 / Node.js v24.11.1（ブラウザでの計測は未実施。下記「未完了」を参照）

## 状況サマリー

| 項目 | 状態 | 結論 |
|---|---|---|
| kdbxweb + Argon2（作成・保存・再読込・添付） | ✅ 完了 | 想定どおり動作 |
| KeePassXC との相互運用 | ✅ 完了 | 双方向に開ける（KDBX 4 / Argon2id、KDBX 3.1 / AES-KDF とも） |
| 鍵導出の設定値 | 🔶 暫定決定（Phase 3 で確定） | Node での計測に基づく暫定値。ブラウザでの再計測が必要 |
| ライブラリの保守状況 | ✅ 完了 | **想定外の点あり**（kdbxweb の依存に既知の脆弱性。後述） |
| kdbxweb のマージ機能 | ✅ 完了 | `Kdbx.merge()` で統合できる。手での入れ直しは不要 |
| S3 の条件付き書き込み | ✅ 完了 | 想定どおり成功と 412 になる |
| API Gateway → Lambda のバイナリと上限 | ✅ 完了 | 要求・応答とも約 4.5 MiB が限界。上限値は 4 MiB に決定 |

## 1. kdbxweb と Argon2

### 採用候補

| ライブラリ | 採用版 | 公開日 | 最新版 | 備考 |
|---|---|---|---|---|
| kdbxweb | 2.1.1 | 2021-09-06 | 2.1.1 | 2021 年以降リリースなし。代わりになる JS 実装はほぼないため採用する |
| hash-wasm（Argon2 実装・WebAssembly） | 4.12.0 | 2024-11-19 | 4.13.0（2026-11-07） | 最新版は公開から 14 日未満のため 4.12.0 に固定 |
| @noble/hashes（Argon2 実装・純 JS） | 2.4.0 | 2026-08-27 | 2.4.0 | 比較用。WebAssembly 不要 |
| @xmldom/xmldom（kdbxweb の依存） | 0.8.15 を override | 2026-08-21 | — | 後述 |

`npm audit` の結果：override 後は 0 件。

### 想定と違った点：kdbxweb の依存 @xmldom/xmldom に既知の脆弱性

kdbxweb 2.1.1 は `@xmldom/xmldom@^0.7.4` に依存しており、そのまま入れると 0.7.13 が入る。0.7.x / 0.8.14 以下には high の脆弱性が多数ある（XML インジェクション、ReDoS など。`npm audit` で 15 件以上）。

- ブラウザでは kdbxweb はブラウザ組み込みの `DOMParser` / `XMLSerializer` を使い、xmldom は呼ばれない（`lib/utils/xml-utils.ts` で `global.DOMParser` を優先）。Node（テスト・検証時）でのみ xmldom が使われる。
- 対応：`package.json` の `overrides` で `@xmldom/xmldom` を `0.8.15`（公開から 14 日以上）に固定した。0.7 → 0.8 の変更後も、下記の検証がすべて通ることを確認した。
- 本実装の画面のバンドルでは、xmldom がバンドルに入らない（またはブラウザで呼ばれない）ことを Phase 3 で確認する。

### 検証結果（`npm run all`）

- hash-wasm と @noble/hashes の Argon2id 出力が一致：OK
- KDBX 4 / Argon2id で作成 → 保存 → 再読込：OK（両実装）
- 標準フィールド、日本語メモ、保護付きの独自フィールド：OK
- 添付ファイル（秘密鍵を想定）の追加・取り出し（バイト一致）：OK
- 誤ったパスワードでは `InvalidKey` で開けない：OK

### 相互運用

| 方向 | 結果 |
|---|---|
| kdbxweb で作成 → pykeepass 4.2.0 で開く | OK（kdf=argon2id、KDBX 4.0、パスワード・メモ・独自フィールド・添付すべて一致） |
| pykeepass で作成（Argon2d）→ kdbxweb で開く | OK（項目と添付を取得） |
| kdbxweb で作成 → KeePassXC 2.7.10 で開く | OK（KDBX 4 / Argon2id 64MiB を認識。パスワード・日本語メモ・独自フィールド・添付の秘密鍵がすべて一致。hash-wasm 版・noble 版とも） |
| KeePassXC 2.7.10 で新規作成 → kdbxweb で開く | OK（項目と添付を取得）。ただし `keepassxc-cli db-create` は KDBX 3.1 / AES-KDF で作る |
| KeePassXC 2.7.10 が Argon2id の KDBX 4 を編集・保存 → kdbxweb で開く | OK（KDBX 4.0 / Argon2id。元の項目・添付と、KeePassXC が追加した項目・添付の両方を取得） |

確認方法：ホストに KeePassXC を入れず、使い捨てコンテナ（`debian:trixie-slim` + Debian 公式パッケージ `keepassxc-minimal` 2.7.10）で `keepassxc-cli` を動かした。

```bash
cd verification
npm ci
npm run kdbx -- --no-bench        # out/ に検証用ファイルを作る
./keepassxc-container.sh          # コンテナ内で verify-keepassxc.sh を実行
npm run kdbx -- --no-bench        # KeePassXC が作ったファイルを kdbxweb で開いた結果を表示
```

想定と違った点：`keepassxc-cli db-create` は KDF を指定できず、KDBX 3.1 / AES-KDF のファイルを作る（GUI の新規作成は KDBX 4 が既定）。KeePassXC が書き出した Argon2id ファイルを確かめるため、kdbxweb で作った Argon2id ファイルを KeePassXC で編集・保存し、それを kdbxweb で開く手順を `verify-keepassxc.sh` に加えた。この手順でも kdbxweb で開けることを確認した。

### 鍵導出の設定値（Argon2id 所要時間、Node・本機、p=2）

| メモリ | 反復 | hash-wasm | @noble/hashes |
|---|---|---|---|
| 16 MiB | 2 | 26 ms | 113 ms |
| 32 MiB | 2 | 52 ms | 226 ms |
| 64 MiB | 2 | 104 ms | 455 ms |
| 64 MiB | 3 | 151 ms | 672 ms |
| 128 MiB | 2 | 213 ms | — |
| 256 MiB | 2 | 428 ms | — |

暫定決定：

- **Argon2 実装は hash-wasm を採用する。** 純 JS の @noble/hashes は約 4.5 倍遅く、同じ待ち時間で弱い設定しか選べない。その代わり CSP に `'wasm-unsafe-eval'` を加える（HANDOFF 3.4 節で認められている例外）。
- **設定値は Argon2id、メモリ 64 MiB、反復 6、並列度 2 を暫定値とする。** 本機で約 0.3 秒。ブラウザの WebAssembly は Node より遅く、一般的なノート PC は本機より遅いことを見込んでも数秒以内に収まる見込み。メモリ 64 MiB は KeePassXC の既定値と同じで、スマホのブラウザでも確保できる大きさに抑えた。
- Phase 3 で画面ができたら、ブラウザで実測して確定する。

## 2. kdbxweb のマージ機能（`npm run merge`）

kdbxweb には `Kdbx.merge(remote)` がある。412 が返ったときは「最新版を取り直して、手元の保管庫に `merge()` し、保存し直す」動作で対応できる。

| 確認項目 | 結果 |
|---|---|
| 端末 A と B がそれぞれ追加した項目が両方残る | OK |
| B の削除（ごみ箱への移動）が反映される | OK |
| ごみ箱無効時の完全削除（墓標）も反映される | OK |
| 同じ項目を両方が編集した場合、更新時刻が新しい側が勝つ | OK |
| 負けた側の値は項目の履歴に残る | OK |

注意点：

- kdbxweb の削除は、既定ではごみ箱グループへの移動になる。画面ではごみ箱の中身を通常の一覧から除いて表示する。
- 更新時刻は秒精度。1 秒以内の競合では勝敗が意図どおりにならない可能性があるが、負けた側も履歴に残るのでデータは失われない。
- `merge()` の後、remote 側のオブジェクトは参照で共有されるため変更しないこと（kdbxweb のドキュメントより）。

## 3. S3 の条件付き書き込み（`node s3-conditional.mjs <バケット名>`）

- 実施：us-east-1、一時バケット（パブリックアクセス全面ブロック、バージョニング有効）を作成して実行し、検証後に全バージョンとバケットを削除した。
- SDK：@aws-sdk/client-s3 3.1161.0

| 確認項目 | 結果 |
|---|---|
| バケットのバージョニングが有効 | OK |
| 新規作成 `IfNoneMatch: "*"` → 成功 | OK（200、ETag を返す） |
| 既存のキーに `IfNoneMatch: "*"` → 412 | OK（`PreconditionFailed`） |
| 正しい ETag で `IfMatch` → 成功 | OK（200、新しい ETag を返す） |
| 古い ETag で `IfMatch` → 412 | OK（`PreconditionFailed`） |
| GetObject の ETag が最新の PutObject の ETag と一致し、内容は最新版のまま | OK |

補足：412 になった書き込みは新しいバージョンを作らない（成功した 2 回分のバージョンだけが残った）。SDK のエラーは `name === 'PreconditionFailed'`、`$metadata.httpStatusCode === 412` で判別できる。Lambda ではこれを API の 412 に変換する。

## 4. API Gateway HTTP API → Lambda のバイナリと上限（`verification/apigw-limit/`）

- 実施：us-east-1 に検証用の Lambda（nodejs24.x、arm64、256 MB）と HTTP API（ペイロード形式 2.0）を一時的に作り、測定後に API・関数・IAM ロール・ロググループをすべて削除した（`deploy.sh` / `measure.mjs` / `teardown.sh`）。
- 方法：`application/octet-stream` の乱数バイナリを POST し、Lambda が受け取った長さと SHA-256 を照合。GET では Lambda が N バイトを Base64 で返し、受け取った長さと内容を照合。二分探索で 1 KiB 精度の最大値を求めた。

| 方向 | 結果 | 最大サイズ | 超えたとき |
|---|---|---|---|
| 要求（保存） | バイナリは `isBase64Encoded: true` で届き、内容が一致 | 4,717,696 バイト（約 4.499 MiB） | API Gateway が **413** `Request Entity Too Large` を返す（Lambda は呼ばれない） |
| 応答（取得） | `isBase64Encoded: true` で返したバイナリがそのまま届く | 4,718,336 バイト（約 4.500 MiB） | API Gateway が **500** `Internal Server Error` を返す |

どちらも、Base64 後の大きさ（4.5 MiB × 4/3 = 6 MiB）が Lambda の 6 MB 制限に当たって止まる。HTTP API の 10 MB 制限より先にこちらが効く。

想定と違った点：応答側の制限を超えると **500** になり、保管庫を取得できなくなる。保存できたのに取得できない状態を避けるため、上限は応答側を基準に余裕を持たせて決める必要がある。

**決定：保管庫の上限は 4 MiB（4,194,304 バイト）。** Lambda は本文がこれを超えたら 413 を返す。測定値との差（約 0.5 MiB）は、Authorization ヘッダー（JWT）、ETag などのヘッダー、イベントの JSON の枠の分の余裕とする。画面では 4 MiB に対する使用量を表示し、例えば 3.5 MiB を超えたら警告する。

## 次に必要な対応

Phase 0 の項目はすべて完了した。Phase 1 で反映すること：

- Argon2 実装は hash-wasm 4.12.0。CSP の `script-src` に `'wasm-unsafe-eval'` を加える。
- `@xmldom/xmldom` は overrides で 0.8.15 に固定し、画面のバンドルから除外する。
- 412 のときは最新版を取り直して `Kdbx.merge()` で統合する。
- 保管庫の上限は 4 MiB。Lambda で超過時に 413 を返す。
- Lambda のランタイムは nodejs24.x（arm64）で動作を確認済み。
- 鍵導出の設定値（Argon2id、64 MiB、反復 6、並列度 2）は、Phase 3 でブラウザでの実測をもとに確定する。

## 付記：Phase 1 で判明したこと

- **aws-cdk-lib 2.275.0 が同梱する minimatch に moderate の指摘**（GHSA-g3hv-75wg-m249、パターン展開による DoS）。aws-cdk-lib の同梱依存（bundledDependencies）のため overrides では差し替えられない。手元でのデプロイ作業（cdk synth / deploy）でだけ使われ、Lambda や画面には含まれない。入力は自分で書いた CDK コードだけなので、実害はないと判断して受け入れる。aws-cdk-lib を更新するときに解消を確認する。
- TypeScript は 7 系（ネイティブ実装に作り直された版）を避け、6.0.3 に固定した。
- **存在しないキーに `IfMatch` を付けた PutObject は、412 ではなく 404（`NoSuchKey`）になる。** Phase 0 では既存のキーでだけ確かめていたため見落としていた。Phase 2 の結合確認で、他人の ETag を使って未作成の自分の保管庫に保存しようとした場合に 500 になって発覚した（書き込みは行われず、他人の保管庫にも影響はない）。Lambda で 404 も 412 として扱うように直し、単体テスト（`api/test/s3-store.test.ts`）を加えた。
- 同じキーへの条件付き書き込みが同時に走った場合、S3 は 409（`ConditionalRequestConflict`）を返すことがある（AWS の仕様）。これも 412 として扱い、画面側で取り直しとマージを行う。

## Phase 1・2 の完了確認（2026-11-15、`NagiVault-dev`、us-east-1）

| 完了条件 | 結果 | 方法 |
|---|---|---|
| `cdk deploy` で全リソースが作られる | OK | |
| CloudFront のドメインで画面が HTTPS で開ける | OK | HTTP は HTTPS へ 301 |
| 画面配信用 S3 に直接アクセスすると拒否される | OK | S3 の URL は 403 |
| CSP などのセキュリティヘッダーが付く | OK | `curl -I` で確認 |
| トークンなしの要求が API Gateway で拒否される | OK | GET / PUT / 偽のトークンとも 401 |
| 別の利用者は他人の保管庫に触れられない | OK | `scripts/e2e-lambda.mjs`（Lambda を直接呼び出し、実際の S3 で確認） |
| 同じ ETag で2回保存すると2回目が 412 | OK | 同上 |
| Lambda のログに本文やトークンが出ない | OK（この範囲では） | ログは利用者 ID・メソッド・状態・サイズ・処理時間だけ。Phase 4 で実際の利用後に再確認する |

実際の Cognito のトークンを使った確認（他人のトークンで他人の保管庫に触れないこと）は、ログイン画面ができる Phase 3 で行う。

## Phase 3 の確認（2026-11-15）

### ローカル（`npm run dev`、模擬 API、Chrome 157）

| 確認内容 | 結果 |
|---|---|
| 保管庫の新規作成（KDBX 4 / Argon2id 64 MiB・反復 6・並列度 2） | OK |
| 項目の追加（標準フィールド、日本語、保護付きの追加フィールド、秘密鍵の添付） | OK |
| メモに `<script>` を入れても文字として表示される（innerHTML を使わない） | OK |
| 誤ったマスターパスワードは「マスターパスワードが違います。」で拒否 | OK |
| ロックして開き直す | OK |
| 別端末（Node + kdbxweb で模擬）が先に保存 → ブラウザで編集して保存 → 412 → 最新版を取り込んで再保存。両方の変更が残る | OK |
| 項目の削除はごみ箱へ移動し、一覧から消える | OK |
| ブラウザで保存した保管庫を KeePassXC 2.7.10（コンテナ）で開き、全フィールド・添付・ごみ箱の中身が一致 | OK |
| コンソールにエラーなし | OK |
| 配信物に @xmldom/xmldom の本体が含まれない（スタブのみ） | OK |

### 鍵導出の設定値（確定）

ブラウザ（Chrome 157、本機）で保管庫を開くのにかかった時間は **約 0.48 秒**（誤ったパスワードでも約 0.44 秒）。hash-wasm は1スレッドで計算するため、CPU のコア数ではなく1コアの速さで決まる。一般的なノート PC で本機の 2〜4 倍かかっても 1〜2 秒に収まるので、**Argon2id・64 MiB・反復 6・並列度 2 で確定**する。

### 開発環境（`NagiVault-dev`）

- 画面が実際の CSP の下でエラーなく表示される：OK
- ログインボタンからマネージドログインへ移動する。登録されていない戻り先 URL は `redirect_mismatch` で拒否される：OK
- トークン取得の窓口が画面のドメインからの呼び出しを許可している（CORS）：OK
- 実際のログインと保管庫の操作は、利用者が手元で確認する（ログインのパスワードと TOTP は利用者だけが扱う）。

## 5. 署名付き URL による S3 への直接送受信（案1、2026-11-15 追加）

### 経緯

利用者から「重要書類も保管するので 4 MiB では足りない」との要望があり、HANDOFF 5 章で範囲外としていた「署名付き URL で S3 に直接送る方式」を採用した。保管庫を kdbx ファイル1つで管理する方針、ブラウザだけで暗号化する方針は変えていない。月額固定の費用は増えない。

### 方式

| 操作 | 流れ |
|---|---|
| 取得 | `GET /api/vault` → Lambda が HeadObject し、ETag・サイズ・ダウンロード用の署名付き URL（5 分）を返す → ブラウザが S3 から直接取得。ETag は S3 の応答のものを使う |
| 保存 | `POST /api/vault/upload-url`（`{ size, ifMatch }` または `{ size, ifNoneMatch: "*" }`）→ Lambda が条件と大きさを署名に含めたアップロード用 URL（5 分）を返す → ブラウザが S3 に直接 PUT。条件が合わなければ S3 が 412 を返す |

- 保存先のキーは、これまでどおりトークンの `sub` からだけ組み立てる。
- 条件なしの上書きはできない。`If-Match` / `If-None-Match`・`Content-Length`・`Content-Type` をヘッダーのまま署名に含める（`unhoistableHeaders`）ので、ブラウザ側で外したり変えたりすると S3 が 403 を返す。
- 保管庫の上限は **64 MiB**（Lambda の `MAX_VAULT_BYTES`）。宣言した大きさが上限を超えれば URL を発行しない（413）。
- 保管庫用バケットに CORS を設定し、画面のドメインからの GET / PUT だけを許可して ETag を読めるようにした。
- CSP の `connect-src` に保管庫用バケットの S3 ドメインだけを加えた（ワイルドカードは使わない）。名前を CSP に書くため、保管庫用バケットの名前を自動生成から固定名（`nagi-vault-<env>-vault-<ハッシュ>`）に変えた。自動生成のままだと CloudFront → CSP → バケット → CORS → CloudFront の循環参照になる。

### 実機での確認（`verification/s3-presigned.mjs`、us-east-1、開発環境の保管庫用バケットの `presign-test/` で実施し、後片付け済み）

| 確認項目 | 結果 |
|---|---|
| 条件ヘッダーを付けずに送る | 403 |
| 署名と違う大きさで送る | 403 |
| 正しく送る（新規作成） | 200、ETag を返す |
| 同じ URL で再送（既に存在） | 412 |
| `If-Match` を別の値に差し替える | 403 |
| `If-Match` の URL に `If-None-Match` を付けて送る | 403 |
| 正しい ETag で更新 | 200 |
| 同じ ETag で再送 | 412 |
| 期限切れの URL | 403 |
| 署名付き GET | 200、最新版、ETag 付き |

署名付き URL のホストは `<バケット名>.s3.us-east-1.amazonaws.com`（仮想ホスト形式）。

### ブラウザでの確認（ローカル、模擬 API）

| 確認項目 | 結果 |
|---|---|
| 20 MiB の添付を追加して保存 | 約 1.9 秒 |
| ロックして開き直す | 約 0.7 秒 |
| 別端末が先に保存 → ブラウザで編集して保存 → 412 → 取り込んで再保存（20 MiB を含む） | 約 4.5 秒、両方の変更が残る |
| ページのメモリ使用量（20 MiB の保管庫を開いた状態） | 約 240 MiB |

注意点：

- 保存のたびに保管庫全体を送るので、大きくなるほど保存が遅くなる。64 MiB では保存に数秒〜十数秒かかる見込み。
- メモリは保管庫の大きさの 10 倍程度を使う。64 MiB では 600 MiB 前後になり、スマホのブラウザでは厳しい可能性がある（スマホは HANDOFF の範囲外）。
- 古い版は 90 日残るため、大きな保管庫を頻繁に保存すると保管料が増える。例：50 MiB を 90 日で 100 回保存すると約 5 GB、月 0.12 ドル程度。AWS Budgets の 1 ドル通知で気づける。

### 移行と旧バケットの削除（2026-11-15）

- 保管庫用バケットを固定名（`nagi-vault-dev-vault-<ハッシュ>`）に変えたとき、旧バケットにあった利用者の保管庫（最新版）を新しいバケットへコピーした。サイズと ETag が一致することを確認した。
- 利用者が新しいバケットの保管庫を開いて保存できたこと（移行後に 2 回保存）を確認した後、利用者の了承を得て旧バケット（移行前の 2 版）を削除した。
