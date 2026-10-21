#!/usr/bin/env bash
# Hard-rule check: the names are assembled at runtime so this file never contains them.
set -euo pipefail
root="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
a="$(printf 'claim%s' 'yours')"; b="$(printf 'james %s ai' 'revenue')"; c="$(printf 'jamesrev%s' 'enueai')"
if grep -rniE "$a|$b|$c" "$root" --include='*.ts' --include='*.tsx' --include='*.md' --include='*.sql' --include='*.json' --include='*.css' --include='*.html' --include='*.mjs' --include='*.sh' --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=dist --exclude-dir=.git --exclude-dir=proof; then
  echo "FORBIDDEN NAME FOUND"; exit 1
fi
echo "forbidden-name grep: clean"
