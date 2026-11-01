import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

export interface ZipMember {
  name: string;
  size: number;
  sha256: string;
  /** 0 = stored, 8 = deflated. We always store. */
  method: number;
  utf8: boolean;
}

/**
 * Unpack with CPython's zipfile — an implementation that shares no code with
 * ours — and return what it saw. `testzip()` checks every member's CRC-32.
 */
export function extractZip(archive: string, dest: string): ZipMember[] {
  mkdirSync(dest, { recursive: true });
  const script = `
import hashlib, json, sys, zipfile
archive, dest = sys.argv[1], sys.argv[2]
members = []
with zipfile.ZipFile(archive) as handle:
    bad = handle.testzip()
    if bad is not None:
        raise SystemExit("corrupt member: " + bad)
    handle.extractall(dest)
    for info in handle.infolist():
        data = handle.read(info.filename)
        members.append({
            "name": info.filename,
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "method": info.compress_type,
            "utf8": bool(info.flag_bits & 0x800),
        })
print(json.dumps(members))
`;
  const raw = execFileSync('python3', ['-c', script, archive, dest], { encoding: 'utf8' });
  return JSON.parse(raw) as ZipMember[];
}
