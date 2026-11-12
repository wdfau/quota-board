#!/bin/bash
set -euo pipefail
base="$(cd "$(dirname "$0")" && pwd)"
if [ -d "$base/额度看板.app" ]; then
    app="$base/额度看板.app"
elif [ -d "$base/额度看板/额度看板.app" ]; then
    app="$base/额度看板/额度看板.app"
else
    printf '找不到额度看板.app，请把启动器和应用放在同一个文件夹。\n' >&2
    exit 1
fi
exec /usr/bin/open "$app"
