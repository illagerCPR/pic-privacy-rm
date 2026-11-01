#!/usr/bin/env python3
"""Fetch the public sample images used by the real-world regression.

Upstream is ExifTool's test corpus (github.com/exiftool/exiftool, `t/images`),
pinned to one commit and checked against a SHA-256 per file. The files land in
git-ignored `tests/real/`, so `pnpm test && pnpm verify` exercises them
locally; CI never downloads anything.

Run `pnpm real` once, then the normal test commands pick the samples up.
"""

from __future__ import annotations

import hashlib
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "tools" / "real-images.json"
TARGET = ROOT / "tests" / "real"
PREFIX = "exiftool-"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    manifest = json.loads(MANIFEST.read_text())
    base = f"https://raw.githubusercontent.com/exiftool/exiftool/{manifest['pin']}/t/images/"
    TARGET.mkdir(parents=True, exist_ok=True)

    failures: list[str] = []
    added = 0
    skipped = 0
    for name, expected in manifest["files"].items():
        dest = TARGET / f"{PREFIX}{name}"
        if dest.exists() and sha256(dest.read_bytes()) == expected:
            skipped += 1
            continue
        try:
            with urllib.request.urlopen(base + name, timeout=60) as response:
                data = response.read()
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{name}: download failed ({exc!r})")
            continue
        actual = sha256(data)
        if actual != expected:
            failures.append(f"{name}: sha256 {actual} != {expected}")
            continue
        dest.write_bytes(data)
        added += 1
        print(f"added {dest.name} ({len(data)} bytes)")

    print(f"{added} downloaded, {skipped} already present")
    if failures:
        print("\nfailed:")
        for item in failures:
            print(f"  - {item}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
