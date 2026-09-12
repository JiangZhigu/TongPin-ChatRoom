#!/bin/sh
set -eu
PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sh "$PROJECT_ROOT/tongpin.sh" install --bootstrap-tools --download-python "$@"
printf '%s\n' 'Installation complete. See INSTALL-PYTHON.zh-CN.md for account setup and startup.'
