from __future__ import annotations

import sys

from _common import main, python, run

if __name__ == "__main__":
    main(lambda: run([python(), "-m", "tongpin", *sys.argv[1:]]))
