"""Read settings from a `.env` file, so the key isn't pasted into every window.

`run.py` calls `load_env_files()` before the blueprint is imported. It reads
`demo/.env`, then `.env` at the repo root, and puts what it finds into
`os.environ`, which is where `workflow_helper_routes.py` looks. A variable
already set in the window wins: `$env:KAIJU_LLM_MODEL = ...` is a deliberate
act for this run, the file is a stored default.

The repo-root file belongs to the TypeScript CLI and uses the shorter `LLM_*`
names, so a value found there fills in the matching `KAIJU_LLM_*` setting when
that one is unset. One file can drive both.

Standard library only: `python-dotenv` would be one more thing to install on
the work laptop.
"""
import os
from pathlib import Path

# The settings the demo reads, without their `KAIJU_LLM_` prefix (see the
# blueprint's docstring for what each one does).
_SETTINGS = (
    "ENDPOINT",
    "MODEL",
    "API_KEY",
    "VISION_ENDPOINT",
    "VISION_MODEL",
    "VISION_API_KEY",
    "TIMEOUT_SECONDS",
    "CA_BUNDLE",
)


def parse_env_file(text):
    """`KEY=value` lines to a dict. A leading `export `, blank lines and `#` comments are fine.

    Everything after the first `=` is the value, so a key containing `#` survives
    (which also means a trailing `# comment` becomes part of the value). Matching
    quotes around a value are dropped. A malformed line is skipped rather than
    fatal: a typo in an optional setting shouldn't stop the demo.
    """
    values = {}
    for raw_line in text.lstrip("﻿").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()

        key, separator, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if not separator or not key or not key.replace("_", "").isalnum():
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def load_env_files(start=None):
    """Fill `os.environ` from `demo/.env` and then the repo root `.env`.

    Returns `(files, aliases)` for the startup message: `files` is a list of
    `(path, names taken from it)`, `aliases` a list of `"KAIJU_LLM_X from LLM_X"`
    lines. Neither holds any value, so printing them can't show the key.
    """
    demo_dir = Path(start or __file__).resolve().parent
    files = []

    for path in (demo_dir / ".env", demo_dir.parent / ".env"):
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as error:
            print(f"Could not read {path}: {error}")
            continue

        applied = []
        for key, value in parse_env_file(text).items():
            if os.environ.get(key, "").strip():
                continue  # already set in this window, which wins
            os.environ[key] = value
            applied.append(key)
        files.append((path, applied))

    return files, _apply_aliases()


def _apply_aliases():
    """`LLM_MODEL` (the CLI's name) fills in `KAIJU_LLM_MODEL` when that is unset."""
    filled = []
    for setting in _SETTINGS:
        target, source = "KAIJU_LLM_" + setting, "LLM_" + setting
        if not os.environ.get(target, "").strip() and os.environ.get(source, "").strip():
            os.environ[target] = os.environ[source]
            filled.append(f"{target} from {source}")
    return filled
