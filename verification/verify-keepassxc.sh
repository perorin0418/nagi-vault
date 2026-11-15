#!/usr/bin/env bash
# Phase 0: KeePassXC との相互運用を確認する（利用者が手元で実行する）
# 前提: keepassxc-cli にパスが通っている（または KPXC_CLI で指定）。先に `npm run kdbx` で out/ にファイルを作っておく。
set -euo pipefail
CLI="${KPXC_CLI:-keepassxc-cli}"
cd "$(dirname "$0")/out"
PW='correct horse battery staple'
for f in created-hashwasm.kdbx created-noble.kdbx; do
  echo "== kdbxweb で作ったファイルを KeePassXC で開く: $f"
  printf '%s\n' "$PW" | "$CLI" db-info "$f"
  printf '%s\n' "$PW" | "$CLI" show -s -a Password -a Notes -a CustomField "$f" example
  printf '%s\n' "$PW" | "$CLI" attachment-export --stdout "$f" example id_ed25519
done
echo "== KeePassXC でファイルを作る（Argon2id 既定）: external-keepassxc.kdbx"
rm -f external-keepassxc.kdbx
printf '%s\n%s\n' "$PW" "$PW" | "$CLI" db-create -p external-keepassxc.kdbx
printf '%s\n' "$PW" | "$CLI" add -u carol external-keepassxc.kdbx from-keepassxc
printf 'binary-from-keepassxc' > kpxc.bin
printf '%s\n' "$PW" | "$CLI" attachment-import external-keepassxc.kdbx from-keepassxc kpxc.bin kpxc.bin
rm -f kpxc.bin
echo "== 続けて 'npm run kdbx' を実行すると external-keepassxc.kdbx を kdbxweb で開いた結果が出る"
