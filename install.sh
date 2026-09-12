#!/bin/sh
set -eu
TP_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$TP_ROOT/scripts/bootstrap_unix.sh"
tp_install "$@"
