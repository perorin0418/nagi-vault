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
