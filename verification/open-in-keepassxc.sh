#!/usr/bin/env bash
# kdbx ファイルを、使い捨てのコンテナの KeePassXC（コマンド版）で開いて、項目と添付ファイルの一覧を表示する。
# ホストに KeePassXC を入れずに済む。パスワードの値そのものは表示しない。
#
# マスターパスワードはこのスクリプトが（画面に表示せずに）受け取り、コンテナには標準入力で渡す。
# 引数や環境変数には載せない（プロセス一覧やログに残さないため）。
# Git Bash（mintty）では Windows 版 docker が端末を扱えず `-t` が使えないため、この方式にしている。
#
# 使い方（自分の端末で実行する）:
#   ./open-in-keepassxc.sh <kdbx ファイルのパス>
set -euo pipefail
FILE="${1:?kdbx ファイルのパスを指定してください}"
[ -f "$FILE" ] || { echo "ファイルがありません: $FILE" >&2; exit 1; }
DIR=$(cd "$(dirname "$FILE")" && (pwd -W 2>/dev/null || pwd))
NAME=$(basename "$FILE")

if [ -t 0 ]; then
  read -rsp "マスターパスワード: " PW
  echo
else
  IFS= read -r PW # パイプで渡された場合（自動テスト用）
fi
echo "コンテナを準備しています（初回は 1 分ほどかかります）…"

printf '%s\n' "$PW" | MSYS_NO_PATHCONV=1 docker run --rm -i -v "$DIR:/data:ro" -e NAME="$NAME" debian:trixie-slim bash -c '
  set -e
  IFS= read -r PW   # 最初に標準入力からパスワードを読む（後のコマンドに標準入力を渡さない）
  apt-get update -qq </dev/null >/dev/null
  apt-get install -y -qq --no-install-recommends keepassxc-minimal </dev/null >/dev/null 2>&1
  c() { printf "%s\n" "$PW" | keepassxc-cli "$@" 2>/dev/null; }
  if ! c db-info "/data/$NAME" >/dev/null; then echo "開けませんでした（マスターパスワードが違うか、ファイルが壊れています）"; exit 1; fi
  echo "== 保管庫の情報"; c db-info "/data/$NAME" | grep -E "Name|Cipher|KDF|Number of"
  echo "== 項目（グループごと）"; c ls -R -f "/data/$NAME"
  echo "== 添付ファイル"
  c ls -R -f "/data/$NAME" | grep -v "/$" | while IFS= read -r e; do
    a=$(c show "/data/$NAME" "$e" --show-attachments | sed -n "/^Attachments:/,\$p" | tail -n +2)
    if [ -n "$a" ]; then printf "%s\n%s\n" "$e" "$a"; fi
  done
'
unset PW
