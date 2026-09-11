from __future__ import annotations

import os
import subprocess
import time

from _common import ROOT, environment, main, node, python


def dev():
    import psutil

    processes = []
    commands = [
        [python(), "-m", "tongpin"],
        [node(), str(ROOT / "node_modules/vite/bin/vite.js"), "--host", "localhost"],
    ]
    try:
        for index, command in enumerate(commands):
            process = subprocess.Popen(
                command,
                cwd=ROOT if index == 0 else ROOT / "apps/web",
                env=environment(),
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            processes.append((process, psutil.Process(process.pid).create_time()))
        print(
            "Tongpin development: http://localhost:5173 (Ctrl+C stops only these processes)",
            flush=True,
        )
        while all(process.poll() is None for process, _ in processes):
            time.sleep(0.3)
        failed = next((p.returncode for p, _ in processes if p.returncode), 0)
        if failed:
            raise subprocess.CalledProcessError(failed, "Tongpin development service")
    finally:
        for process, created in reversed(processes):
            try:
                owned = psutil.Process(process.pid)
                if owned.create_time() != created:
                    continue
                children = owned.children(recursive=True)
                for child in reversed(children):
                    child.terminate()
                owned.terminate()
                _, alive = psutil.wait_procs([owned, *children], timeout=5)
                for child in alive:
                    child.kill()
            except psutil.NoSuchProcess:
                pass


if __name__ == "__main__":
    main(dev)
