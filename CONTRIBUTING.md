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
| `pnpm check` | typecheck + unit tests + build + offline assertion |

## Architecture

```
src/core/      pure container logic, no DOM, fully testable in Node
  sniff.ts       magic bytes → format
  jpeg.ts        marker walk, allow-list, entropy scan
  png.ts         chunk walk + CRC checks
  webp.ts        RIFF chunks + VP8X flag fixups
  gif.ts         block walk
  tiff.ts        TIFF/EXIF IFD reader
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
src/lib/       browser helpers: worker client, formatting, hex dump
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

## Testing

Three independent layers, because a metadata remover that lies is worse than no tool at all:

1. **Synthetic fixtures** (`tools/make_fixtures.py`) build JPEG/PNG/WebP/GIF files with REAL structures:
   EXIF with GPS and an IFD1 thumbnail, XMP with a base64 thumbnail, IPTC-IIM, JFXX, MPF, C2PA/JUMBF with a
   real self-signed certificate and split APP11 segments, plus broken and unsupported inputs.
2. **Round-trip tests** (`tests/roundtrip.test.ts`) assert the findings, strip every fixture, re-scan the
   output, and write it to `tests/output/` for the next layer.
3. **Independent verification** (`tools/verify.py`) decodes the outputs with Pillow — not with our own
   code — and checks that no EXIF/GPS/XMP/IPTC/C2PA survives, that the pixels are byte-identical to the
   input, and that the files still decode.
4. **End-to-end tests** (`e2e/`) drive the real UI in Chrome: upload, inspect the drawer, clean, download
   the ZIP and inspect its bytes; check orientation baking; open the all-metadata tab, expand a MakerNote
   hex dump and compare the listing against the cleaned output; assert that the page made zero external
   requests; and load the production build with the network switched off to prove the service worker
   keeps the app usable offline.

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

## Commits

Commits are signed (`git commit -S`) and authored with the GitHub privacy address. Keep them focused:
a container change with its fixtures and tests in one commit beats a sweeping refactor.
