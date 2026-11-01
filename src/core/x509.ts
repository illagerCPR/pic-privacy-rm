/** Just enough ASN.1/DER to show who signed a C2PA manifest. */

export interface CertSummary {
  commonName?: string;
  organization?: string;
  issuerCommonName?: string;
  issuerOrganization?: string;
  notBefore?: string;
  notAfter?: string;
  serial?: string;
}

interface Tlv {
  tag: number;
  length: number;
  contentStart: number;
  end: number;
}

function readTlv(b: Uint8Array, pos: number, end: number): Tlv | null {
  if (pos + 2 > end) return null;
  const tag = b[pos] ?? 0;
  let p = pos + 1;
  let length = b[p] ?? 0;
  p += 1;
  if (length & 0x80) {
    const n = length & 0x7f;
    if (n === 0 || n > 4 || p + n > end) return null;
    length = 0;
    for (let i = 0; i < n; i += 1) length = length * 256 + (b[p + i] ?? 0);
    p += n;
  }
  if (length < 0 || p + length > end) return null;
  return { tag, length, contentStart: p, end: p + length };
}

function children(b: Uint8Array, tlv: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let pos = tlv.contentStart;
  while (pos < tlv.end) {
    const child = readTlv(b, pos, tlv.end);
    if (!child) break;
    out.push(child);
    pos = child.end;
  }
  return out;
}

function decodeString(b: Uint8Array, tlv: Tlv): string {
  const bytes = b.subarray(tlv.contentStart, tlv.end);
  switch (tlv.tag) {
    case 0x0c:
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    case 0x1e: {
      let s = '';
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        s += String.fromCharCode(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0));
      }
      return s;
    }
    default: {
      let s = '';
      for (const c of bytes) s += String.fromCharCode(c);
      return s;
    }
  }
}

function parseTime(b: Uint8Array, tlv: Tlv): string | undefined {
  const raw = new TextDecoder('ascii').decode(b.subarray(tlv.contentStart, tlv.end)).trim();
  if (tlv.tag === 0x17 && raw.length >= 12) {
    const yy = Number(raw.slice(0, 2));
    const year = yy >= 50 ? 1900 + yy : 2000 + yy;
    return `${year}-${raw.slice(2, 4)}-${raw.slice(4, 6)}`;
  }
  if (tlv.tag === 0x18 && raw.length >= 8) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  return raw || undefined;
}

function parseName(b: Uint8Array, nameTlv: Tlv): { cn?: string; org?: string } {
  let cn: string | undefined;
  let org: string | undefined;
  for (const set of children(b, nameTlv)) {
    for (const rdn of children(b, set)) {
      const parts = children(b, rdn);
      if (parts.length < 2) continue;
      const oid = parts[0];
      const value = parts[1];
      if (!oid || !value || oid.tag !== 0x06 || oid.length !== 3) continue;
      const oidBytes = b.subarray(oid.contentStart, oid.end);
      if (oidBytes[0] !== 0x55 || oidBytes[1] !== 0x04) continue;
      if (oidBytes[2] === 0x03) cn = cn ?? decodeString(b, value);
      if (oidBytes[2] === 0x0a) org = org ?? decodeString(b, value);
    }
  }
  return { cn, org };
}

export function parseCertificate(der: Uint8Array): CertSummary | null {
  try {
    const root = readTlv(der, 0, der.length);
    if (!root || root.tag !== 0x30) return null;
    const certKids = children(der, root);
    const tbs = certKids[0];
    if (!tbs || tbs.tag !== 0x30) return null;
    const kids = children(der, tbs);
    let i = 0;
    if (kids[i]?.tag === 0xa0) i += 1; // version
    const serialTlv = kids[i];
    i += 1; // serial
    i += 1; // signature algorithm
    const issuerTlv = kids[i];
    i += 1;
    const validityTlv = kids[i];
    i += 1;
    const subjectTlv = kids[i];

    const summary: CertSummary = {};
    if (serialTlv) {
      summary.serial = Array.from(der.subarray(serialTlv.contentStart, serialTlv.end), (x) =>
        x.toString(16).padStart(2, '0'),
      )
        .join('')
        .slice(0, 32);
    }
    if (issuerTlv && issuerTlv.tag === 0x30) {
      const issuer = parseName(der, issuerTlv);
      summary.issuerCommonName = issuer.cn;
      summary.issuerOrganization = issuer.org;
    }
    if (subjectTlv && subjectTlv.tag === 0x30) {
      const subject = parseName(der, subjectTlv);
      summary.commonName = subject.cn;
      summary.organization = subject.org;
    }
    if (validityTlv && validityTlv.tag === 0x30) {
      const times = children(der, validityTlv);
      summary.notBefore = times[0] ? parseTime(der, times[0]) : undefined;
      summary.notAfter = times[1] ? parseTime(der, times[1]) : undefined;
    }
    return summary;
  } catch {
    return null;
  }
}
