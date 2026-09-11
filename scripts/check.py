from __future__ import annotations

from _common import main, npm, python, run


def check():
    run([python(), "-m", "ruff", "check", "src", "scripts", "tests"])
    run([python(), "-m", "pytest"])
    run(npm("run", "check", "--workspace", "@tongpin/web"))
    run(npm("run", "test", "--workspace", "@tongpin/web"))


if __name__ == "__main__":
    main(check)
