#!/usr/bin/env bash
# KeePassXC との相互運用確認を、使い捨てコンテナ（Debian 公式パッケージの keepassxc-cli）で行う。
# ホストに KeePassXC を入れずに済む。事前に `npm run kdbx` で out/ にファイルを作っておくこと。
set -euo pipefail
cd "$(dirname "$0")"
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W 2>/dev/null || pwd):/work" -w /work debian:trixie-slim bash -c '
  set -e
  apt-get update -qq >/dev/null
  (apt-get install -y -qq --no-install-recommends keepassxc-minimal || apt-get install -y -qq --no-install-recommends keepassxc) >/dev/null 2>&1
  echo "keepassxc-cli $(keepassxc-cli --version)"
  KPXC_CLI=keepassxc-cli bash ./verify-keepassxc.sh
'
