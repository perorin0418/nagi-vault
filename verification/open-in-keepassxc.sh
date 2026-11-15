#!/usr/bin/env bash
# kdbx ファイルを、使い捨てのコンテナの KeePassXC（コマンド版）で開いて、項目と添付ファイルの一覧を表示する。
# ホストに KeePassXC を入れずに済む。マスターパスワードはコンテナの中で本人が入力する（画面には表示されない）。
# パスワードの値そのものは表示しない（KeePassXC は既定で保護付きの値を隠す）。
# 使い方（自分の端末で実行すること。パスワードの入力が必要なため）:
#   ./open-in-keepassxc.sh <kdbx ファイルのパス>
set -euo pipefail
FILE="${1:?kdbx ファイルのパスを指定してください}"
[ -f "$FILE" ] || { echo "ファイルがありません: $FILE" >&2; exit 1; }
DIR=$(cd "$(dirname "$FILE")" && (pwd -W 2>/dev/null || pwd))
NAME=$(basename "$FILE")
TTY=-i; [ -t 0 ] && TTY=-it
MSYS_NO_PATHCONV=1 docker run --rm $TTY -v "$DIR:/data:ro" -e NAME="$NAME" debian:trixie-slim bash -c '
  set -e
  apt-get update -qq >/dev/null
  apt-get install -y -qq --no-install-recommends keepassxc-minimal >/dev/null 2>&1
  read -rsp "マスターパスワード: " PW; echo
  c() { printf "%s\n" "$PW" | keepassxc-cli "$@" 2>/dev/null; }
  echo "== 保管庫の情報"; c db-info "/data/$NAME" | grep -E "Name|Cipher|KDF|Number of"
  echo "== 項目（グループごと）"; c ls -R -f "/data/$NAME"
  echo "== 添付ファイル"
  c ls -R -f "/data/$NAME" | grep -v "/$" | while IFS= read -r e; do
    a=$(c show "/data/$NAME" "$e" --show-attachments 2>/dev/null | sed -n "/^Attachments:/,\$p" | tail -n +2)
    [ -n "$a" ] && printf "%s\n%s\n" "$e" "$a"
  done
  unset PW
'
