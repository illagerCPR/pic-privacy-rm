#!/usr/bin/env python3
"""Independent verification of stripped output.

Deliberately does not use the TypeScript engine: Pillow decodes the files and
checks for leftover metadata, and raw byte patterns catch container-level
metadata the image library would silently ignore.

Exit code is non-zero if any check fails.
"""

from __future__ import annotations

import io
import subprocess
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"
OUTPUT = ROOT / "tests" / "output"
REAL = ROOT / "tests" / "real"
REAL_OUTPUT = OUTPUT / "real"

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


# A stripped JPEG may only keep the segments a decoder needs.
JPEG_APP_PREFIXES = {0xE0: b"JFIF", 0xE2: b"ICC_PROFILE", 0xEE: b"Adobe"}


def jpeg_header_problems(name: str, data: bytes) -> list[str]:
    problems: list[str] = []
    pos = 2
    while pos + 4 <= len(data):
        if data[pos] != 0xFF:
            break
        marker = data[pos + 1]
        if marker in (0xDA, 0xD9):
            break
        if marker == 0x00 or 0xD0 <= marker <= 0xD7:
            pos += 2
            continue
        length = int.from_bytes(data[pos + 2 : pos + 4], "big")
        if length < 2:
            break
        if marker == 0xFE:
            problems.append(f"{name}: JPEG comment segment survived")
        elif 0xE0 <= marker <= 0xEF:
            prefix = JPEG_APP_PREFIXES.get(marker)
            payload = data[pos + 4 : pos + 4 + len(prefix or b"")]
            if prefix is None:
                problems.append(f"{name}: APP{marker - 0xE0} segment survived")
            elif payload != prefix:
                problems.append(f"{name}: APP{marker - 0xE0} is not the expected {prefix.decode()!r}")
        pos += 2 + length
    return problems


def src_has_icc(path: Path) -> bool:
    try:
        with Image.open(path) as im:
            return "icc_profile" in im.info
    except Exception:  # noqa: BLE001
        return False


def pixels(path: Path) -> bytes:
    with Image.open(path) as im:
        return im.convert("RGB").tobytes(), im.size


def heif_frame(path: Path) -> bytes:
    """Decode the primary picture of a HEIF container with ffmpeg.

    `0:g:0` selects the tile grid (the real picture); a file without one falls
    back to the first video stream. Selecting the grid also proves the rebuild
    kept the grid mapping: a broken one decodes to a single tile instead.
    """
    for selector in ("0:g:0", "0:v:0"):
        proc = subprocess.run(
            [
                "ffmpeg", "-v", "error", "-i", str(path),
                "-map", selector, "-frames:v", "1",
                "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
            ],
            capture_output=True,
        )
        if proc.returncode == 0 and proc.stdout:
            return proc.stdout
    return b""


def heif_streams(path: Path) -> list[str]:
    """Container-level stream description, for files whose codec payload is a stub."""
    proc = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "stream=index,codec_name,width,height",
            "-of", "csv=p=0", str(path),
        ],
        capture_output=True,
    )
    return [line for line in proc.stdout.decode(errors="replace").splitlines() if line.strip()]


def heif_check(name: str, src: Path, out: Path) -> list[str]:
    """Pillow cannot open HEIF, so ffmpeg stands in as the independent decoder."""
    problems: list[str] = []
    if not out.exists():
        return [f"{name}: missing stripped output"]

    before = heif_frame(src)
    after = heif_frame(out)
    if before or after:
        if not before:
            return [f"{name}: source does not decode with ffmpeg (skipped)"]
        if not after:
            problems.append(f"{name}: output does not decode with ffmpeg")
        elif before != after:
            problems.append(f"{name}: picture data changed after stripping")
    else:
        # ExifTool's samples carry stub payloads: compare the container's
        # declared streams instead of pixels.
        source_streams = heif_streams(src)
        out_streams = heif_streams(out)
        if source_streams != out_streams:
            problems.append(f"{name}: stream layout changed {source_streams} -> {out_streams}")

    data = out.read_bytes()
    for marker, label in (
        (b"Exif\x00\x00", "Exif item"),
        (b"x:xmpmeta", "XMP item"),
        (b"rdf:RDF", "XMP item"),
    ):
        if marker in data:
            problems.append(f"{name}: found {label}")
    return problems


def check(name: str, src_dir: Path = FIXTURES, out_dir: Path = OUTPUT) -> list[str]:
    problems: list[str] = []
    src = src_dir / name
    out = out_dir / name
    if not out.exists():
        return [f"{name}: missing stripped output"]
    if name.lower().endswith((".heic", ".heif")):
        return heif_check(name, src, out)

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
    keep_icc = name in {"meta.jpg", "meta.png", "meta.webp"} or (
        src_dir == REAL and src_has_icc(src)
    )
    if keep_icc and "icc_profile" not in info_keys:
        problems.append(f"{name}: ICC profile was dropped unexpectedly")

    if fmt == "JPEG":
        problems.extend(jpeg_header_problems(name, data))

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

    if REAL_OUTPUT.exists():
        print()
        print("real-world samples:")
        for path in sorted(REAL_OUTPUT.iterdir()):
            if not path.is_file():
                continue
            problems = check(path.name, src_dir=REAL, out_dir=REAL_OUTPUT)
            checked += 1
            if problems:
                failures.extend(problems)
                print(f"FAIL {path.name}")
                for item in problems:
                    print(f"     - {item}")
            else:
                print(f"ok   {path.name}")

    print()
    if failures:
        print(f"{len(failures)} problem(s) across {checked} files")
        return 1
    print(f"all {checked} files verified: no EXIF/XMP/GPS/IPTC/C2PA left, pixels unchanged")
    return 0


if __name__ == "__main__":
    sys.exit(main())
