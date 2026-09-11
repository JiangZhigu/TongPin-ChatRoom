from __future__ import annotations

from _common import main, npm, run
from build_receipt import inputs, write


def build():
    before = inputs()
    run(npm("run", "build", "--workspace", "@tongpin/web"))
    write(before)

if __name__ == "__main__":
    main(build)
