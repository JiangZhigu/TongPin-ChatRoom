from __future__ import annotations

from _common import main, npm, run

if __name__ == "__main__":
    main(lambda: run(npm("run", "build", "--workspace", "@tongpin/web")))
