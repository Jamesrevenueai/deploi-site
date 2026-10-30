#!/usr/bin/env bash
# Shared helpers for the production runbook scripts. Never prints a database URL.
set -euo pipefail
need() { command -v "$1" >/dev/null 2>&1 || { echo "MISSING TOOL: $1 ($2)"; exit 2; }; }
# ref of a Supabase project from a pooler or direct URL (user is "postgres.<ref>" or host is "db.<ref>.supabase.co")
project_ref() { python3 - "$1" <<'PY'
import sys, re, urllib.parse
u = urllib.parse.urlparse(sys.argv[1])
m = re.match(r'^postgres\.([a-z0-9]{20})$', u.username or '') or re.match(r'^db\.([a-z0-9]{20})\.supabase\.co$', u.hostname or '')
print(m.group(1) if m else '')
PY
}
# transaction pooler (6543) cannot run pg_dump reliably; use the session pooler (5432) on the same host
session_url() { python3 - "$1" <<'PY'
import sys, urllib.parse
u = urllib.parse.urlparse(sys.argv[1])
if u.port == 6543:
    netloc = u.netloc.rsplit(':', 1)[0] + ':5432'
    u = u._replace(netloc=netloc)
print(urllib.parse.urlunparse(u))
PY
}
hr() { printf '\n%s\n' "================================================================"; }
