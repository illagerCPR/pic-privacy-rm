# Contributing

Thanks for taking a look. This document is for people changing the code; the user-facing story lives in
[README.md](README.md).

## Requirements

- Node.js 24 and pnpm 11
- Python 3.10+ with Pillow and `cryptography` (fixtures and independent verification)
- Google Chrome (end-to-end tests use `channel: "chrome"`, so no browser download is needed)

## Getting started

```bash
pnpm install
pnpm dev          # http://localhost:5188
```

| Command | What it does |
| --- | --- |
| `pnpm dev` | Vite dev server (no CSP, HMR) |
| `pnpm build` | Production build into `dist/` (CSP injected) |
| `pnpm preview` | Serve the production build |
| `pnpm typecheck` | `tsc --noEmit`, strict |
| `pnpm test` | Vitest unit + round-trip tests |
| `pnpm test:e2e` | Playwright against a real Chrome |
| `pnpm fixtures` | Regenerate `tests/fixtures/` |
| `pnpm verify` | Pillow-based verification of `tests/output/` |
| `pnpm real` | Fetch the pinned public sample corpus into `tests/real/` |
| `pnpm check` | typecheck + unit tests + build + offline assertion |

## Architecture

```
src/core/      pure container logic, no DOM, fully testable in Node
  sniff.ts       magic bytes → format
  jpeg.ts        marker walk, allow-list, entropy scan
  png.ts         chunk walk + CRC checks
  webp.ts        RIFF chunks + VP8X flag fixups
  gif.ts         block walk
  isobmff.ts     ISO BMFF boxes: iloc / iinf / iref / ipma read and rewrite
  heif.ts        HEIC/AVIF item table, allow-list rebuild, lossless payload repack
  tiff.ts        TIFF/EXIF IFD reader (shared with the Exif item of every format)
  tiff-image.ts  TIFF directory rebuild: allow-list entries, relocated strips and tiles
  gps.ts         DMS → decimal, display fields
  xmp.ts         tolerant XMP scanner
  iptc.ts        Photoshop APP13 / IPTC-IIM
  jumbf.ts       JUMBF boxes (C2PA lives here)
  cbor.ts        minimal CBOR decoder
  c2pa.ts        manifest summary (store → manifest → claim/actions/signature)
  x509.ts        just enough DER for a certificate's CN and validity
  metadata.ts    every entry expanded for the "all metadata" view
  inspect.ts     the lazy listing pass, works on any Blob (source or output)
  pipeline.ts    scan / strip / verify orchestration
src/workers/   the same pipeline, off the main thread
src/hooks/     React state machine for the file list
src/lib/       browser helpers: worker client, formatting, hex dump, JSON report,
               store-only ZIP writer (zip.ts)
src/components/ UI
```

### Invariants

1. **Allow-list, not block-list.** A container fragment is kept only when it is needed to decode the
   image; everything else is dropped, including metadata we have never seen. New formats must follow this.
2. **The strip pass never depends on successful parsing.** Recognising a GPS tag is for the report;
   removal is structural. A malformed XMP packet still gets deleted.
3. **Never emit unverified output.** `stripSource` re-analyses its own output and the UI refuses to offer
   a download when anything sensitive survives.
4. **No re-encoding by default.** Output is assembled from zero-copy `Blob` slices. Orientation baking is
   the only path that touches a canvas, and it is opt-in.
5. **No network, ever.** `connect-src 'none'` ships in the build; `tools/check_offline.mjs` fails CI if an
   external URL appears in the bundle (string constants for namespaces and clickable links are allow-listed).
6. **Strips run one at a time.** The limiter is not re-entrant: nesting it deadlocks when two outer jobs
   hold every slot. Batch code calls `stripOne`, which handles concurrency itself.
7. **Archives are assembled, not re-compressed.** `src/lib/zip.ts` writes a store-only ZIP whose members
   are the stripped `Blob`s themselves, so packaging two gigabytes costs a few kilobytes of headers. The
   only pass over the bytes is the CRC-32; deflating would add a full copy of the batch and save nothing on
   already-compressed images.

## Testing

Three independent layers, because a metadata remover that lies is worse than no tool at all:

1. **Synthetic fixtures** (`tools/make_fixtures.py`) build JPEG/PNG/WebP/GIF/HEIC/AVIF/TIFF files with REAL structures:
   EXIF with GPS and an IFD1 thumbnail, XMP with a base64 thumbnail, IPTC-IIM, JFXX, MPF, C2PA/JUMBF with a
   real self-signed certificate and split APP11 segments, plus broken and unsupported inputs.
2. **Round-trip tests** (`tests/roundtrip.test.ts`) assert the findings, strip every fixture, re-scan the
   output, and write it to `tests/output/` for the next layer.
3. **Independent verification** (`tools/verify.py`) decodes the outputs with Pillow — not with our own
   code — and checks that no EXIF/GPS/XMP/IPTC/C2PA survives, that the pixels are byte-identical to the
   input, and that the files still decode. HEIC and AVIF go through ffmpeg instead, for two different
   reasons: Pillow cannot open HEIC at all, and for AVIF it *synthesises* an `Exif` block from the
   container's `irot` — a stripped file then reports an orientation tag that is not in its bytes. The
   HEIC sample ExifTool ships has a stub codec payload, so for that one the container's declared stream
   layout is compared rather than pixels. TIFF gets its own check: Pillow's `getexif()` returns IFD0
   there, so the tags are audited against an allow-list and every page's pixels are compared.
4. **End-to-end tests** (`e2e/`) drive the real UI in Chrome: upload, inspect the drawer, clean, download
   the ZIP and unpack it with CPython's `zipfile` (`e2e/zip.ts`) — an implementation that shares no code
   with ours and checks every member's CRC-32; check orientation baking and the pre-clean orientation warning; open the
   all-metadata tab, expand a MakerNote hex dump and compare the listing against the cleaned output; assert
   that the page made zero external requests; and load the production build with the network switched off
   to prove the service worker keeps the app usable offline.
5. **Real-world samples** (`tests/real.test.ts`) run camera and phone exports through the same pipeline.
   The folder is git-ignored because it holds personal photos: drop files into `tests/real/` and
   `pnpm test && pnpm verify` will clean them and decode the output with Pillow. `pnpm real` fetches a
   fixed set of public samples from ExifTool's corpus (commit plus per-file SHA-256 in
   `tools/real-images.json`), so the same coverage is one command away. CI skips this layer.

Re-running `tools/make_fixtures.py` regenerates every binary, and a different Pillow version has drifted
files nobody touched (`broken.jpg`, `meta.jpg`, `meta.png`, `meta.webp`). Keep the diff to what you meant to
change: `git checkout --` the rest.

## Adding a format

1. Write `src/core/<format>.ts` exporting `analyzeX(source, options): Promise<ContainerAnalysis>`.
2. Return `parts` describing the output (slices of the source or fresh bytes), findings, and blocks.
3. Register it in `src/core/pipeline.ts` and `src/core/sniff.ts`.
4. Generate a fixture for the format, add expectations to `tools/make_fixtures.py`, and extend
   `tools/verify.py` if Pillow can decode the format.
5. Check the "keep" list against the specification — dropping a colour or structural chunk produces files
   that look fine in one viewer and break in another.

## Gotchas worth remembering

- JPEG APP1 payloads carry the `Exif\0\0` prefix; PNG `eXIf` and WebP `EXIF` chunks do not.
- WebP's `VP8X` flag byte is `bit5 ICC, bit4 alpha, bit3 EXIF, bit2 XMP, bit1 animation` — getting it wrong
  yields files that no decoder opens.
- C2PA claims/assertions/signatures are JUMBF **superboxes**; the CBOR payload is a child box, not the
  superbox payload itself.
- GIF XMP is an application extension with the identifier `XMP Data…`; the comment extension is `0xFE`.
- The entropy-coded data after SOS must be scanned for the next marker; a naive "copy the rest" keeps
  appended metadata.
- `metadata.ts` and `inspect.ts` are a viewer, never a gate. The strip pass must keep working when parsing
  fails, so nothing in the listing is allowed to decide what gets removed.
- The listing's container group is mixed: JFIF, Adobe APP14 and (depending on the setting) ICC survive,
  unknown APPn do not. Kept/removed is per item; a group may only claim a removal when something really goes.
- C2PA 2.x labels a manifest `urn:c2pa:<uuid>`, not `c2pa.manifest`. Matching the label alone misses every
  current generator (OpenAI's images, for one). Find the deepest superbox that owns a `c2pa.claim`.
- Cameras without a position fix still write a GPS IFD full of zeros. Treat `0°, 0°` as "no fix" or the
  report invents a location in the Gulf of Guinea; vivo's Android build does exactly this.
- XMP is XML and may be UTF-16: decode the BOM (or the zero-byte pattern) before scanning. ExifTool keeps a
  big-endian UTF-16 sample precisely because tools get this wrong; ours reported an empty packet.
- Exported reports are a public format now. Add fields, never rename or repurpose them, and keep binaries
  out: payloads are described by size.
- A ZIP built from Blob references still has to describe each member: `method = 0`, the real CRC-32 in the
  local header, and bit 11 of the flags set or non-ASCII names turn into mojibake. Sizes and offsets are
  32-bit, so an archive past 4 GiB needs Zip64 — we refuse it with a clear message instead of writing one
  that no tool can unpack.

HEIF-specific traps, all of which produced a broken file at least once:

- A HEIF `Exif` item is `[4-byte offset][Exif\0\0][TIFF]`, and the offset counts from the end of that
  four-byte field. Slicing at `offset` yields `"if\0\0MM"` and `parseTiff` returns null — which looks like
  "the parser does not support HEIC" rather than an off-by-four.
- `ipma`'s `item_ID` is 16-bit in version 0 and 32-bit in version 1. Reading it as 32-bit shifts the whole
  association table and invents item ids like 66435.
- `iloc` keeps version 0 unable to express `construction_method`. An item stored in `idat` (`method=1`)
  needs the file's original version preserved, or its data address disappears.
- Deleting metadata items means rewriting `iinf`, `iloc` **and** `iref` together. A dangling `cdsc`
  reference to a removed item is a container some parsers reject.
- `iprp` must contain the whole `ipco` box, not just its body: dropping the header produces a container
  that ffmpeg refuses to open and nothing else complains about.
- Real iPhone files put the Exif item *between* picture tiles in `mdat`, so the payload of every later item
  moves. Rebuild by writing the surviving payloads in source order and assigning offsets as you go instead
  of trying to patch addresses in place.
- ffmpeg decodes a HEIF tile grid only with `-map 0:g:0`; `-map 0:v:0` hands you a single 512×512 tile and
  an unchanged checksum that proves nothing.
- HEIC and AVIF are the same container. Decide the format from `ftyp` brands, never from the file
  extension, and check the compatibility list as well: `mif1` is the generic brand and can hold either
  codec.
- Pillow maps a container's `irot` to an EXIF orientation tag when reading AVIF, so `getexif()` is not
  evidence of leftover metadata there. Look at the bytes (`Exif\0\0`, `x:xmpmeta`) instead.
- A `moov` box means an image sequence (`avis`, live photos). It is refused outright rather than stripped:
  dropping it would leave an animation that no longer plays.

TIFF-specific traps, in the order they bit:

- A TIFF has no metadata segment. Descriptive tags sit in the same image file directory as `StripOffsets`,
  so the strip pass is a directory rebuild: keep the structural entries, drop the rest, re-lay the strips
  and rewrite the offset table. There is nothing here you can skip past.
- Pillow's `getexif()` on a TIFF returns IFD0 itself, so a "no EXIF left" assertion can never pass for a
  stripped file. `tools/verify.py` checks a tag allow-list instead: structural tags must survive, private
  ones must not.
- Compute offsets and write bytes from the same layout object. Forgetting the one-byte alignment pad
  between the value area and the image data shifts every strip by one; only the last strip falls off the
  end of the file, so the symptom is a "bad offset table" rather than "misplaced data", and unit tests with
  even-length strips cannot see it.
- `NewSubfileType` bit 0 marks a reduced-resolution directory: a thumbnail, not a page. Leave it and the
  cleaned file still carries a second copy of the picture.
- Compression 7 means every strip is its own JPEG stream (tables live in tag `0x015b`), so each strip has to
  go through the JPEG engine or its APPn survives. Compression 6 hides the stream behind tag `0x0201` and is
  refused instead of guessed at.
- Magic 42 is not enough to identify a file: BigTIFF uses 43, and DNG/CR2/NEF/ARW raws wear the same header.
  Recognise them, then refuse them — a "clean" would turn a raw into a broken file.
- Pillow's TIFF writer only writes what it needs. `282`/`283`/`296`/`254`/`317` are often absent from the
  source, so "present before, missing after" is not automatically a regression: compare against the source's
  own tag set.

## Commits

Commits are signed (`git commit -S`) and authored with the GitHub privacy address. Keep them focused:
a container change with its fixtures and tests in one commit beats a sweeping refactor.
