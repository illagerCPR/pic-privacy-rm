#!/usr/bin/env python3
"""Independent verification of stripped output.

Deliberately does not use the TypeScript engine: Pillow decodes the files and
checks for leftover metadata, and raw byte patterns catch container-level
metadata the image library would silently ignore.

Exit code is non-zero if any check fails.
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"
OUTPUT = ROOT / "tests" / "output"

# Metadata markers that must not survive a strip pass.
FORBIDDEN = {
    b"Exif\x00\x00": "JPEG APP1 Exif segment",
    b"http://ns.adobe.com/xap/1.0/": "JPEG APP1 XMP segment",
    b"http://ns.adobe.com/xmp/extension/": "JPEG extended XMP",
    b"Photoshop 3.0\x00": "JPEG APP13 Photoshop/IPTC",
    b"c2pa": "C2PA / JUMBF payload",
    b"caBX": "PNG C2PA chunk",
    b"XMP DataXMP": "GIF XMP extension",
    b"ICC_PROFILE\x00": "JPEG ICC (kept by default, checked separately)",
}

CASES = [
    "plain.jpg", "meta.jpg", "progressive.jpg", "rotated.jpg",
    "plain.png", "meta.png",
    "plain.webp", "meta.webp",
    "plain.gif", "meta.gif",
]


def pixels(path: Path) -> bytes:
    with Image.open(path) as im:
        return im.convert("RGB").tobytes(), im.size


def check(name: str) -> list[str]:
    problems: list[str] = []
    src = FIXTURES / name
    out = OUTPUT / name
    if not out.exists():
        return [f"{name}: missing stripped output"]

    try:
        with Image.open(out) as im:
            im.load()
            exif = im.getexif()
            info_keys = set(im.info.keys())
            fmt = im.format
    except Exception as exc:  # noqa: BLE001
        return [f"{name}: output does not decode ({exc!r})"]

    if len(exif) != 0:
        problems.append(f"{name}: EXIF still readable ({len(exif)} tags: {dict(exif)})")
    gps = exif.get_ifd(0x8825) if exif else {}
    if gps:
        problems.append(f"{name}: GPS IFD still present {dict(gps)}")
    for key in ("exif", "xmp", "XML:com.adobe.xmp", "Author", "Comment"):
        if key in info_keys:
            problems.append(f"{name}: pillow still exposes info[{key!r}]")

    data = out.read_bytes()
    for marker, label in FORBIDDEN.items():
        if marker == b"ICC_PROFILE\x00":
            continue  # covered below
        if marker in data:
            problems.append(f"{name}: found {label}")
    if b"\xff\xeb" in data and name.endswith(".jpg"):
        # APP11 markers may only appear inside scan data; check the header walk.
        pos, header = 2, True
        while header and pos + 4 <= len(data):
            if data[pos] != 0xFF:
                break
            marker = data[pos + 1]
            if marker == 0xDA:
                header = False
                break
            length = int.from_bytes(data[pos + 2 : pos + 4], "big")
            if marker == 0xEB:
                problems.append(f"{name}: APP11 JUMBF segment survived")
            pos += 2 + length

    # ICC is kept by default; make sure the strip did not damage it.
    if name in {"meta.jpg", "meta.png", "meta.webp"}:
        if "icc_profile" not in info_keys:
            problems.append(f"{name}: ICC profile was dropped unexpectedly")

    # Pixels must be identical: the strip is byte surgery, not re-encoding.
    try:
        a, size_a = pixels(src)
        b, size_b = pixels(out)
        if size_a != size_b:
            problems.append(f"{name}: dimensions changed {size_a} -> {size_b}")
        elif a != b:
            problems.append(f"{name}: pixel data changed!")
    except Exception as exc:  # noqa: BLE001
        problems.append(f"{name}: cannot compare pixels ({exc!r})")

    # Trailing data must be gone for JPEG/PNG.
    if fmt == "JPEG":
        eoi = data.rfind(b"\xff\xd9")
        if eoi != len(data) - 2:
            problems.append(f"{name}: data after JPEG EOI ({len(data) - eoi - 2} bytes)")
    if fmt == "PNG":
        if not data.endswith(b"IEND\xaeB`\x82"):
            problems.append(f"{name}: PNG does not end with IEND")

    return problems


def main() -> int:
    if not OUTPUT.exists():
        print("no output directory - run `pnpm test` first")
        return 1
    failures: list[str] = []
    checked = 0
    for name in CASES:
        problems = check(name)
        checked += 1
        if problems:
            failures.extend(problems)
            print(f"FAIL {name}")
            for p in problems:
                print(f"     - {p}")
        else:
            print(f"ok   {name}")

    print()
    if failures:
        print(f"{len(failures)} problem(s) across {checked} files")
        return 1
    print(f"all {checked} files verified: no EXIF/XMP/GPS/IPTC/C2PA left, pixels unchanged")
    return 0


if __name__ == "__main__":
    sys.exit(main())
