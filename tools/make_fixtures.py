#!/usr/bin/env python3
"""Generate deterministic test fixtures for pic-privacy-rm.

Each fixture carries a known set of metadata so the test suite can assert that
* exactly the expected findings are detected, and
* after a strip pass none of them survive while the image still decodes.

Requires Pillow and `cryptography` (used to mint a throwaway signing cert).
"""

from __future__ import annotations

import io
import json
import struct
import zlib
from pathlib import Path

from PIL import Image, ImageCms

OUT = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
OUT.mkdir(parents=True, exist_ok=True)

# --------------------------------------------------------------------------
# CBOR encoding (subset)
# --------------------------------------------------------------------------


def cbor_head(major: int, value: int) -> bytes:
    if value < 24:
        return bytes([(major << 5) | value])
    if value < 0x100:
        return bytes([(major << 5) | 24, value])
    if value < 0x10000:
        return bytes([(major << 5) | 25]) + value.to_bytes(2, "big")
    if value < 0x100000000:
        return bytes([(major << 5) | 26]) + value.to_bytes(4, "big")
    return bytes([(major << 5) | 27]) + value.to_bytes(8, "big")


def cbor(value) -> bytes:
    if value is None:
        return b"\xf6"
    if value is True:
        return b"\xf5"
    if value is False:
        return b"\xf4"
    if isinstance(value, int):
        return cbor_head(0, value) if value >= 0 else cbor_head(1, -1 - value)
    if isinstance(value, bytes):
        return cbor_head(2, len(value)) + value
    if isinstance(value, str):
        raw = value.encode("utf-8")
        return cbor_head(3, len(raw)) + raw
    if isinstance(value, (list, tuple)):
        return cbor_head(4, len(value)) + b"".join(cbor(v) for v in value)
    if isinstance(value, dict):
        return cbor_head(5, len(value)) + b"".join(cbor(k) + cbor(v) for k, v in value.items())
    raise TypeError(type(value))


# --------------------------------------------------------------------------
# JUMBF / C2PA
# --------------------------------------------------------------------------

UUID_SUFFIX = bytes.fromhex("001100108000 00AA00389B71".replace(" ", ""))


def c2pa_uuid(name: str) -> bytes:
    assert len(name) == 4
    return name.encode("ascii") + UUID_SUFFIX


def box(box_type: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", 8 + len(payload)) + box_type + payload


def jumd(uuid: bytes, label: str) -> bytes:
    return box(b"jumd", uuid + bytes([0x03]) + label.encode("utf-8") + b"\x00")


def superbox(uuid: bytes, label: str, children: list[bytes]) -> bytes:
    return box(b"jumb", jumd(uuid, label) + b"".join(children))


def c2pa_cert() -> bytes:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, "PicPrivacy Test Signer"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "PicPrivacy QA"),
        ]
    )
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(__import__("datetime").datetime(2024, 1, 1))
        .not_valid_after(__import__("datetime").datetime(2034, 1, 1))
        .sign(key, hashes.SHA256())
    )
    return cert.public_bytes(serialization.Encoding.DER)


CERT_DER = c2pa_cert()


def c2pa_manifest(thumbnail: bytes | None = None, extra_assertion: bytes | None = None) -> bytes:
    claim = {
        "claim_generator": "PicPrivacy Test/1.0",
        "claim_generator_info": [{"name": "PicPrivacy Test", "version": "1.0"}],
        "dc:title": "test-fixture.jpg",
        "instanceID": "xmp:iid:8f14e45f-ceea-467a-9c1e-1a2b3c4d5e6f",
        "assertions": [
            {"url": "self#jumbf=c2pa.assertions/c2pa.actions", "hash": "deadbeef"},
        ],
    }
    actions = {
        "actions": [
            {
                "action": "c2pa.created",
                "softwareAgent": "PicPrivacy Test 1.0",
                "when": "2024-05-04T12:00:00Z",
                "digitalSourceType": "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture",
            },
            {"action": "c2pa.edited", "softwareAgent": "PicPrivacy Test 1.0"},
        ]
    }
    protected = cbor({1: -7, 33: [CERT_DER]})
    cose = cbor([protected, {}, None, b"\x00" * 64])

    children = [
        superbox(c2pa_uuid("c2cl"), "c2pa.claim", [box(b"cbor", cbor(claim))]),
        superbox(c2pa_uuid("c2as"), "c2pa.assertions", [superbox(c2pa_uuid("c2ac"), "c2pa.actions", [box(b"cbor", cbor(actions))])]),
        superbox(c2pa_uuid("c2cs"), "c2pa.signature", [box(b"cbor", cose)]),
    ]
    if extra_assertion:
        children.append(superbox(c2pa_uuid("c2as"), "c2pa.assertions", [box(b"cbor", extra_assertion)]))
    if thumbnail:
        children.append(superbox(c2pa_uuid("c2th"), "c2pa.thumbnail.claim.jpeg", [box(b"jpeg", thumbnail)]))
    return superbox(c2pa_uuid("c2ma"), "c2pa.manifest", children)


def c2pa_store(manifest: bytes) -> bytes:
    return superbox(c2pa_uuid("c2pa"), "c2pa", [manifest])


# --------------------------------------------------------------------------
# TIFF / EXIF writer (supports IFD0, Exif IFD, GPS IFD, IFD1 thumbnail)
# --------------------------------------------------------------------------

TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4}


def pack_values(t: int, values) -> bytes:
    e = "<"
    if t == 2:
        raw = values.encode("utf-8") + b"\x00"
        return raw
    if t in (1, 6, 7):
        return bytes(values)
    if t == 3:
        return b"".join(struct.pack(e + "H", v & 0xFFFF) for v in values)
    if t == 8:
        return b"".join(struct.pack(e + "h", v) for v in values)
    if t in (4, 13):
        return b"".join(struct.pack(e + "I", v) for v in values)
    if t == 9:
        return b"".join(struct.pack(e + "i", v) for v in values)
    if t in (5, 10):
        f = "I" if t == 5 else "i"
        return b"".join(struct.pack(e + f + f, n, d) for (n, d) in values)
    raise ValueError(t)


def value_count(t: int, values) -> int:
    if t == 2:
        return len(values.encode("utf-8")) + 1
    if t in (5, 10):
        return len(values)
    return len(values)


def build_tiff(
    ifd0: list[tuple[int, int, object]],
    exif: list[tuple[int, int, object]],
    gps: list[tuple[int, int, object]],
    ifd1: list[tuple[int, int, object]],
    thumbnail: bytes | None,
) -> bytes:
    """Serialize a little-endian TIFF with IFD0, Exif, GPS and an optional IFD1 thumbnail."""
    little = "<"

    def ifd_size(n: int) -> int:
        return 2 + 12 * n + 4

    n0 = len(ifd0) + 2  # + ExifIFDPointer + GPSInfoIFDPointer
    n1 = len(exif)
    n2 = len(gps)
    n3 = len(ifd1) + (3 if thumbnail else 0)

    o0 = 8
    o1 = o0 + ifd_size(n0)
    o2 = o1 + ifd_size(n1)
    o3 = o2 + ifd_size(n2)
    data_start = o3 + ifd_size(n3)

    thumb_off = data_start if thumbnail else 0

    def rows(entries, extra=()):
        out = []
        for tag, t, values in list(entries) + list(extra):
            out.append(
                {
                    "tag": tag,
                    "type": t,
                    "count": value_count(t, values),
                    "data": pack_values(t, values),
                }
            )
        out.sort(key=lambda r: r["tag"])
        return out

    ifd0_rows = rows(ifd0, [(0x8769, 4, [o1]), (0x8825, 4, [o2])])
    exif_rows = rows(exif)
    gps_rows = rows(gps)
    ifd1_extra = []
    if thumbnail:
        ifd1_extra = [
            (0x0201, 4, [thumb_off]),
            (0x0202, 4, [len(thumbnail)]),
            (0x0103, 3, [6]),
        ]
    ifd1_rows = rows(ifd1, ifd1_extra)

    data_area = bytearray()
    if thumbnail:
        data_area += thumbnail
        if len(thumbnail) % 2:
            data_area += b"\x00"

    for group in (ifd0_rows, exif_rows, gps_rows, ifd1_rows):
        for row in group:
            if len(row["data"]) <= 4:
                continue
            if len(data_area) % 2:
                data_area += b"\x00"
            row["offset"] = len(data_area) + data_start
            data_area += row["data"]

    def emit(rows_, next_off: int) -> bytes:
        buf = bytearray(struct.pack(little + "H", len(rows_)))
        for row in rows_:
            data = row["data"]
            buf += struct.pack(little + "HHI", row["tag"], row["type"], row["count"])
            if len(data) <= 4:
                buf += data + b"\x00" * (4 - len(data))
            else:
                buf += struct.pack(little + "I", row["offset"])
        buf += struct.pack(little + "I", next_off)
        return bytes(buf)

    out = bytearray()
    out += b"II" + struct.pack("<H", 42) + struct.pack("<I", o0)
    out += emit(ifd0_rows, o3)
    out += emit(exif_rows, 0)
    out += emit(gps_rows, 0)
    out += emit(ifd1_rows, 0)
    out += data_area
    return bytes(out)


def base_image(size=(64, 48)) -> Image.Image:
    img = Image.new("RGB", size)
    px = img.load()
    for y in range(size[1]):
        for x in range(size[0]):
            px[x, y] = ((x * 4) % 256, (y * 5) % 256, ((x + y) * 3) % 256)
    return img


def jpeg_bytes(img: Image.Image, quality=82, progressive=False, exif=None, icc=None) -> bytes:
    buf = io.BytesIO()
    kwargs = {"quality": quality, "progressive": progressive}
    if exif:
        kwargs["exif"] = exif
    if icc:
        kwargs["icc_profile"] = icc
    img.save(buf, "JPEG", **kwargs)
    return buf.getvalue()


def small_jpeg() -> bytes:
    return jpeg_bytes(base_image((32, 24)), quality=70)


def exif_block(thumbnail: bytes, orientation: int = 6) -> bytes:
    ifd0 = [
        (0x010F, 2, "TestCam"),
        (0x0110, 2, "Model X Pro"),
        (0x0131, 2, "PicPrivacy Test 1.0"),
        (0x0132, 2, "2024:05:04 12:00:00"),
        (0x0112, 3, [orientation]),
        (0x013B, 2, "Jane Doe"),
        (0x8298, 2, "(c) 2024 Jane Doe"),
        (0x9C9B, 1, list("Secret title".encode("utf-16-le")) + [0, 0]),
    ]
    exif = [
        (0x9003, 2, "2024:05:04 12:00:00"),
        (0x829A, 5, [(1, 125)]),
        (0x829D, 5, [(28, 10)]),
        (0x8827, 3, [100]),
        (0x920A, 5, [(50, 1)]),
        (0xA434, 2, "Test Lens 50mm"),
        (0xA431, 2, "SN-123456789"),
        (0xA430, 2, "owner@example.com"),
        (0xA420, 2, "0123456789abcdef"),
        (0x9286, 7, list(b"ASCII\x00\x00\x00" + b"a private note")),
        (0x927C, 7, [1, 2, 3, 4, 5, 6, 7, 8]),
    ]
    gps = [
        (0x0001, 2, "N"),
        (0x0002, 5, [(35, 1), (41, 1), (216, 10)]),
        (0x0003, 2, "E"),
        (0x0004, 5, [(139, 1), (41, 1), (301, 10)]),
        (0x0005, 1, [0]),
        (0x0006, 5, [(44, 1)]),
        (0x0007, 5, [(3, 1), (4, 1), (5, 1)]),
        (0x001D, 2, "2024:05:04"),
        (0x001B, 7, list(b"ASCII\x00\x00\x00" + b"GPS")),
    ]
    return build_tiff(ifd0, exif, gps, [], thumbnail)


# --------------------------------------------------------------------------
# XMP packet
# --------------------------------------------------------------------------

XMP_TEMPLATE = """<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
    xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
    xmlns:exif="http://ns.adobe.com/exif/1.0/"
    xmlns:xmpGImg="http://ns.adobe.com/xap/1.0/g/img/"
    xmp:CreatorTool="PicPrivacy Test 1.0"
    xmp:CreateDate="2024-05-04T12:00:00Z"
    xmpMM:DocumentID="xmp.did:12345678-1234-1234-1234-123456789abc"
    photoshop:City="Berlin"
    photoshop:Country="Germany"
    exif:GPSLatitude="52,31.5N"
    exif:GPSLongitude="13,24.5E">
   <dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li></rdf:Seq></dc:creator>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Test photo</rdf:li></rdf:Alt></dc:title>
   <dc:rights><rdf:Alt><rdf:li xml:lang="x-default">(c) 2024 Jane Doe</rdf:li></rdf:Alt></dc:rights>
   <xmpGImg:image>{thumb}</xmpGImg:image>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"""


def import_base64(data: bytes) -> str:
    import base64

    return base64.b64encode(data).decode("ascii")


XMP_PACKET = XMP_TEMPLATE.format(thumb=import_base64(small_jpeg())).encode("utf-8")


def mpf_tiff() -> bytes:
    """Minimal, well-formed Multi-Picture Format TIFF header."""
    header = b"II" + struct.pack("<H", 42) + struct.pack("<I", 8)
    data_start = 8 + 2 + 3 * 12 + 4  # 50
    entries = [
        struct.pack("<HHI", 0xB000, 2, 5) + struct.pack("<I", data_start),  # MPFVersion
        struct.pack("<HHI", 0xB001, 4, 1) + struct.pack("<I", 2),  # NumberOfImages
        struct.pack("<HHI", 0xB002, 7, 32) + struct.pack("<I", data_start + 6),  # MPEntry
    ]
    ifd = struct.pack("<H", 3) + b"".join(entries) + struct.pack("<I", 0)
    blob = b"0100\x00" + b"\x00" + b"\x00" * 32
    return header + ifd + blob


# --------------------------------------------------------------------------
# Container injectors
# --------------------------------------------------------------------------


def jpeg_insert(data: bytes, segments: list[bytes]) -> bytes:
    return data[:2] + b"".join(segments) + data[2:]


def app(marker: int, payload: bytes) -> bytes:
    assert len(payload) + 2 <= 0xFFFF
    return bytes([0xFF, marker]) + struct.pack(">H", len(payload) + 2) + payload


def app_split(marker: int, payload: bytes) -> list[bytes]:
    """Split a payload into several APPn segments of at most 65533 bytes."""
    out = []
    for i in range(0, len(payload), 65533):
        out.append(app(marker, payload[i : i + 65533]))
    return out


def png_chunk(chunk_type: str, payload: bytes) -> bytes:
    t = chunk_type.encode("ascii")
    return struct.pack(">I", len(payload)) + t + payload + struct.pack(">I", zlib.crc32(t + payload) & 0xFFFFFFFF)


def png_insert(data: bytes, chunks: list[bytes]) -> bytes:
    sig = data[:8]
    rest = data[8:]
    ihdr_len = struct.unpack(">I", rest[:4])[0]
    first = rest[: 12 + ihdr_len]
    return sig + first + b"".join(chunks) + rest[12 + ihdr_len :]


def webp_add(data: bytes, extra: list[tuple[bytes, bytes]], flag_or: int = 0) -> bytes:
    out = bytearray(data[:12])
    pos = 12
    while pos + 8 <= len(data):
        fourcc = data[pos : pos + 4]
        size = struct.unpack("<I", data[pos + 4 : pos + 8])[0]
        payload = bytearray(data[pos + 8 : pos + 8 + size])
        if fourcc == b"VP8X" and flag_or:
            payload[0] |= flag_or
        out += fourcc + struct.pack("<I", len(payload)) + payload
        if len(payload) % 2:
            out += b"\x00"
        pos += 8 + size + (size & 1)
    for fourcc, payload in extra:
        out += fourcc + struct.pack("<I", len(payload)) + payload
        if len(payload) % 2:
            out += b"\x00"
    out[4:8] = struct.pack("<I", len(out) - 8)
    return bytes(out)


def gif_insert_before_trailer(data: bytes, blocks: list[bytes]) -> bytes:
    assert data.endswith(b"\x3b")
    return data[:-1] + b"".join(blocks) + b"\x3b"


def gif_subblocks(data: bytes) -> bytes:
    out = bytearray()
    for i in range(0, len(data), 255):
        chunk = data[i : i + 255]
        out += bytes([len(chunk)]) + chunk
    out += b"\x00"
    return bytes(out)


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------


def icc_profile() -> bytes:
    return ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


def write(name: str, data: bytes) -> None:
    (OUT / name).write_bytes(data)
    print(f"  {name:24s} {len(data):8d} bytes")


def main() -> None:
    print(f"writing fixtures to {OUT}")
    thumb = small_jpeg()
    tiff = exif_block(thumb)
    icc = icc_profile()

    # ---------------- JPEG ----------------
    plain = jpeg_bytes(base_image())
    write("plain.jpg", plain)

    meta = bytearray(plain)
    segments = [
        app(0xE1, b"Exif\x00\x00" + tiff),
        app(0xE1, b"http://ns.adobe.com/xap/1.0/\x00" + XMP_PACKET),
        app(0xE1, b"http://ns.adobe.com/xmp/extension/\x00" + b"xmpid" + b"\x00" * 8 + XMP_PACKET[:120]),
        app(0xE2, b"ICC_PROFILE\x00" + bytes([1, 1]) + icc),
    ]
    # IPTC (Photoshop 3.0 with one 8BIM resource carrying IIM datasets)
    def iim(record: int, dataset: int, text: str) -> bytes:
        raw = text.encode("utf-8")
        return bytes([0x1C, record, dataset]) + struct.pack(">H", len(raw)) + raw

    iim_data = (
        iim(2, 80, "Jane Doe")
        + iim(2, 90, "Berlin")
        + iim(2, 101, "Germany")
        + iim(2, 120, "Private caption text")
        + iim(2, 25, "privacy")
        + iim(2, 55, "20240504")
    )
    resource = b"8BIM" + struct.pack(">H", 0x0404) + b"\x00\x00" + struct.pack(">I", len(iim_data)) + iim_data
    if len(iim_data) % 2:
        resource += b"\x00"
    segments.append(app(0xED, b"Photoshop 3.0\x00" + resource))
    # comment, JFXX thumbnail, MPF, C2PA (split across two APP11 segments)
    segments.append(app(0xFE, "private comment here".encode("utf-8")))
    segments.append(app(0xE0, b"JFXX\x00\x10" + thumb))
    segments.append(app(0xE2, b"MPF\x00" + mpf_tiff()))
    store = c2pa_store(c2pa_manifest(thumbnail=thumb))
    noisy = store + b"\x00" * 70000  # force the manifest across several APP11 segments
    segments.extend(app_split(0xEB, noisy))
    segments.append(app(0xE5, b"UNKNOWN-APP5-SECRET"))
    meta = jpeg_insert(bytes(meta), segments) + b"TRAILING-DATA-AFTER-EOI"
    write("meta.jpg", meta)

    prog = jpeg_bytes(base_image((80, 60)), progressive=True, exif=b"Exif\x00\x00" + tiff)
    write("progressive.jpg", prog)

    # A file whose EXIF declares orientation 3 (180°).
    flip = jpeg_bytes(base_image(), exif=b"Exif\x00\x00" + exif_block(thumb, orientation=3))
    write("rotated.jpg", flip)

    # Truncated JPEG (header intact, scan data cut).
    write("broken.jpg", bytes(meta)[: int(len(meta) * 0.6)])

    # ---------------- PNG ----------------
    png_buf = io.BytesIO()
    base_image().save(png_buf, "PNG")
    png_plain = png_buf.getvalue()
    write("plain.png", png_plain)

    xmp_chunk = png_chunk("iTXt", b"XML:com.adobe.xmp\x00\x00\x00\x00\x00" + XMP_PACKET)
    chunks = [
        png_chunk("tEXt", b"Author\x00Jane Doe"),
        png_chunk("zTXt", b"Comment\x00\x00" + zlib.compress(b"a compressed private note")),
        xmp_chunk,
        png_chunk("eXIf", tiff),
        png_chunk("tIME", struct.pack(">HBBBBB", 2024, 5, 4, 12, 0, 0)),
        png_chunk("caBX", c2pa_store(c2pa_manifest())),
        png_chunk("iDOT", b"\x00" * 24),
    ]
    chunks.insert(5, png_chunk("iCCP", b"sRGB\x00\x00" + zlib.compress(icc)))
    png_meta = png_insert(png_plain, chunks) + b"PNG-TRAILER"
    write("meta.png", png_meta)

    # ---------------- WebP ----------------
    webp_buf = io.BytesIO()
    base_image().save(webp_buf, "WEBP", quality=80)
    webp_plain = webp_buf.getvalue()
    write("plain.webp", webp_plain)

    webp_buf = io.BytesIO()
    base_image().save(webp_buf, "WEBP", quality=80, exif=tiff)
    webp_exif = webp_buf.getvalue()
    webp_meta = webp_add(
        webp_exif,
        [
            (b"XMP ", XMP_PACKET),
            (b"ICCP", icc),
            (b"C2PA", c2pa_store(c2pa_manifest())),
        ],
        flag_or=0x24,
    )
    write("meta.webp", webp_meta)

    # ---------------- GIF ----------------
    gif_buf = io.BytesIO()
    base_image((40, 30)).save(gif_buf, "GIF")
    gif_plain = gif_buf.getvalue()
    write("plain.gif", gif_plain)

    comment = b"\x21\xFE" + gif_subblocks(b"secret gif comment")
    xmp_ext = b"\x21\xFF\x0B" + b"XMP DataXMP" + gif_subblocks(XMP_PACKET) 
    loop_ext = b"\x21\xFF\x0BNETSCAPE2.0\x03\x01\x00\x00\x00"
    gif_meta = gif_insert_before_trailer(gif_plain, [comment, xmp_ext, loop_ext])
    write("meta.gif", gif_meta)

    # ---------------- AVIF ----------------
    # Pillow writes AVIF through libavif, which stores EXIF as an `Exif` item —
    # the same container shape as HEIC. XMP cannot be written this way, so the
    # fixture exercises the EXIF path only.
    try:
        avif_plain_buf = io.BytesIO()
        base_image((32, 24)).save(avif_plain_buf, "AVIF")
        write("plain.avif", avif_plain_buf.getvalue())

        avif_meta_buf = io.BytesIO()
        base_image((32, 24)).save(avif_meta_buf, "AVIF", exif=tiff)
        write("meta.avif", avif_meta_buf.getvalue())
    except Exception as exc:  # noqa: BLE001
        print(f"  ! AVIF fixtures skipped ({exc}); keeping the committed files")

    # ---------------- Unsupported / broken inputs ----------------
    write("note.txt", b"this is not an image\n")
    write("fake.heic", b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00heicmif1" + b"\x00" * 32)

    # ---------------- expectations ----------------
    expectations = {
        "plain.jpg": {"format": "jpeg", "findings": []},
        "meta.jpg": {
            "format": "jpeg",
            "findings": ["finding.exif", "finding.gps", "finding.exif.thumbnail", "finding.xmp", "finding.iptc", "finding.c2pa", "finding.comment", "finding.trailer", "finding.orientation", "finding.jfxx.thumbnail", "finding.mpf", "finding.app.unknown"],
        },
        "progressive.jpg": {"format": "jpeg", "findings": ["finding.exif", "finding.gps", "finding.exif.thumbnail", "finding.orientation"]},
        "rotated.jpg": {"format": "jpeg", "findings": ["finding.exif", "finding.gps", "finding.exif.thumbnail", "finding.orientation"]},
        "plain.png": {"format": "png", "findings": []},
        "meta.png": {"format": "png", "findings": ["finding.exif", "finding.gps", "finding.exif.thumbnail", "finding.xmp", "finding.c2pa", "finding.png.text", "finding.png.time", "finding.trailer", "finding.orientation"]},
        "plain.webp": {"format": "webp", "findings": []},
        "meta.webp": {"format": "webp", "findings": ["finding.exif", "finding.gps", "finding.exif.thumbnail", "finding.xmp", "finding.c2pa", "finding.orientation"]},
        "plain.avif": {"format": "avif", "findings": []},
        "meta.avif": {"format": "avif", "findings": ["finding.exif", "finding.gps"]},
        "plain.gif": {"format": "gif", "findings": []},
        "meta.gif": {"format": "gif", "findings": ["finding.xmp", "finding.comment.gif"]},
    }
    (OUT / "expectations.json").write_text(json.dumps(expectations, indent=2) + "\n")
    print("done")


if __name__ == "__main__":
    main()
