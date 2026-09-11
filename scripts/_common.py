from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def environment():
    result = os.environ.copy()
    values = {
        "UV_CACHE_DIR": ROOT / ".codex/cache/uv",
        "npm_config_cache": ROOT / ".codex/cache/npm",
        "TEMP": ROOT / ".codex/cache/tmp",
        "TMP": ROOT / ".codex/cache/tmp",
        "PLAYWRIGHT_BROWSERS_PATH": ROOT / ".codex/cache/playwright",
    }
    for key, path in values.items():
        path.mkdir(parents=True, exist_ok=True)
        result[key] = str(path)
    dotenv = ROOT / ".env"
    if dotenv.exists():
        for line in dotenv.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key, value = key.strip(), value.strip()
            if key.startswith("TONGPIN_") and key not in result:
                if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
                    value = value[1:-1]
                result[key] = value
    result["PYTHONUTF8"] = "1"
    return result


def python():
    path = ROOT / (".venv/Scripts/python.exe" if os.name == "nt" else ".venv/bin/python")
    if not path.exists():
        raise SystemExit("Project .venv is missing. Run npm run setup first.")
    return str(path)


def node():
    path = shutil.which("node")
    if not path:
        raise SystemExit("Node.js 24 is required.")
    return path


def npm(*args):
    binary = Path(node())
    candidates = [
        binary.parent / "node_modules/npm/bin/npm-cli.js",
        binary.parent.parent / "lib/node_modules/npm/bin/npm-cli.js",
    ]
    npm_path = shutil.which("npm")
    if npm_path:
        resolved_npm = Path(npm_path).resolve()
        if resolved_npm.name == "npm-cli.js":
            candidates.append(resolved_npm)
        candidates.append(
            Path(npm_path).resolve().parent.parent / "lib/node_modules/npm/bin/npm-cli.js"
        )
    cli = next((candidate for candidate in candidates if candidate.is_file()), None)
    if cli is None:
        raise SystemExit(
            "Cannot locate npm-cli.js beside Node.js; use a standard Node.js installation."
        )
    return [str(binary), str(cli), *args]


def run(command):
    subprocess.run(command, cwd=ROOT, env=environment(), check=True)


def main(function):
    try:
        function()
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.returncode) from error
    except KeyboardInterrupt:
        raise SystemExit(130) from None
