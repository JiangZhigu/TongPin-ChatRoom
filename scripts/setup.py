from __future__ import annotations

import argparse
import os
import shutil

from _common import ROOT, main, npm, run


def setup():
    parser = argparse.ArgumentParser(
        description="Create/sync the project environment without deleting data"
    )
    parser.add_argument("--skip-node", action="store_true")
    options = parser.parse_args()
    uv = os.environ.get("TONGPIN_UV") or shutil.which("uv")
    if not uv:
        raise SystemExit(
            "uv is required to reproduce uv.lock. Install uv or set TONGPIN_UV to an existing uv executable."
        )
    version = (ROOT / ".python-version").read_text(encoding="utf-8").strip()
    run([uv, "sync", "--locked", "--group", "dev", "--python", version, "--no-python-downloads"])
    if not options.skip_node:
        run(npm("ci", "--ignore-scripts", "--no-audit", "--no-fund"))
    print("Project dependencies ready. No database or user data was removed.")


if __name__ == "__main__":
    main(setup)
