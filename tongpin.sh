#!/bin/sh
set -eu
PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for candidate in "$PROJECT_ROOT/.venv/bin/python" python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3,12) else 1)' >/dev/null 2>&1; then
    exec "$candidate" "$PROJECT_ROOT/scripts/deploy.py" "$@"
  fi
done
printf '%s\n' 'Python 3.12 is required. Install an approved runtime, then run sh tongpin.sh doctor.' >&2
exit 1
