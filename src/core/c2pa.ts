/** Read C2PA manifests embedded in a JUMBF tree. */
import { asMap, asString, decodeCbor, type CborMap, type CborValue } from './cbor.ts';
import { walkJumbf, type JumbfBox } from './jumbf.ts';
import type { C2paAction, C2paManifest } from './types.ts';
import { parseCertificate } from './x509.ts';

export interface C2paSummary {
  present: boolean;
  manifests: C2paManifest[];
  bytes: number;
  boxCount: number;
}

const COSE_ALGORITHMS: Record<number, string> = {
  [-7]: 'ES256',
  [-8]: 'EdDSA',
  [-35]: 'ES384',
  [-36]: 'ES512',
  [-37]: 'PS256',
  [-38]: 'PS384',
  [-39]: 'PS512',
  14: 'SHA-256',
  15: 'SHA-384',
  16: 'SHA-512',
};

function contentPayload(box: JumbfBox): Uint8Array {
  if (box.children && box.children.length > 0) {
    const content = box.children.find((c) => c.type !== 'jumd');
    if (content) return content.payload;
  }
  return box.payload;
}

function looksLikeImage(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return true;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return true;
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true;
  return false;
}

function imagePayload(box: JumbfBox): Uint8Array | null {
  const candidates = [contentPayload(box), box.payload];
  return candidates.find((c) => looksLikeImage(c)) ?? null;
}

function bytesOf(value: CborValue | undefined): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}

function claimGeneratorOf(claim: CborMap): string | undefined {
  const legacy = asString(claim['claim_generator']);
  if (legacy) return legacy;
  const info = claim['claim_generator_info'];
  if (Array.isArray(info)) {
    const parts: string[] = [];
    for (const item of info) {
      const map = asMap(item);
      if (!map) continue;
      const name = asString(map['name']);
      const version = asString(map['version']);
      if (name) parts.push(version ? `${name} ${version}` : name);
    }
    if (parts.length > 0) return parts.join(', ');
  }
  return undefined;
}

function actionsFromAssertion(box: JumbfBox): C2paAction[] {
  const decoded = decodeCbor(contentPayload(box));
  const list = Array.isArray(decoded)
    ? decoded
    : Array.isArray(asMap(decoded)?.['actions'])
      ? (asMap(decoded)?.['actions'] as CborValue[])
      : [];
  const actions: C2paAction[] = [];
  for (const item of list) {
    const map = asMap(item);
    if (!map) continue;
    const action = asString(map['action']);
    if (!action) continue;
    actions.push({
      action,
      when: asString(map['when']),
      softwareAgent: asString(map['softwareAgent']),
      digitalSourceType: asString(map['digitalSourceType']),
      reason: asString(map['reason']),
    });
  }
  return actions;
}

function signatureInfo(box: JumbfBox): { algorithm?: string; signer?: string; issuer?: string; validFrom?: string; validTo?: string } {
  try {
    const cose = decodeCbor(contentPayload(box));
    if (!Array.isArray(cose) || cose.length < 1) return {};
    const protectedBytes = bytesOf(cose[0]);
    if (!protectedBytes) return {};
    const header = asMap(decodeCbor(protectedBytes));
    if (!header) return {};
    const algRaw = header['1'];
    const algorithm = typeof algRaw === 'number' ? COSE_ALGORITHMS[algRaw] : undefined;
    const chain = header['33'];
    const certs = Array.isArray(chain) ? chain : chain instanceof Uint8Array ? [chain] : [];
    const first = certs.find((c): c is Uint8Array => c instanceof Uint8Array);
    if (!first) return { algorithm };
    const cert = parseCertificate(first);
    return {
      algorithm,
      signer: cert?.commonName ?? cert?.organization,
      issuer: cert?.issuerCommonName ?? cert?.issuerOrganization,
      validFrom: cert?.notBefore,
      validTo: cert?.notAfter,
    };
  } catch {
    return {};
  }
}

function extensionToMime(label: string): string {
  const last = label.split('.').pop() ?? '';
  if (last === 'png') return 'image/png';
  if (last === 'webp') return 'image/webp';
  if (last === 'gif') return 'image/gif';
  if (last === 'avif') return 'image/avif';
  return 'image/jpeg';
}

function summarizeManifest(manifest: JumbfBox): C2paManifest {
  const all = walkJumbf([manifest]);
  const claimBox = all.find((b) => b.label === 'c2pa.claim' || b.label.startsWith('c2pa.claim.'));
  const signatureBox = all.find((b) => b.label === 'c2pa.signature' || b.label.startsWith('c2pa.claim-signature'));
  const assertionBoxes = all.filter((b) => b.label === 'c2pa.assertions');
  const thumbnailBox = all.find((b) => b.label.startsWith('c2pa.thumbnail'));

  let claimGenerator: string | undefined;
  let title: string | undefined;
  if (claimBox) {
    try {
      const claim = asMap(decodeCbor(contentPayload(claimBox)));
      if (claim) {
        claimGenerator = claimGeneratorOf(claim);
        title = asString(claim['dc:title']);
      }
    } catch {
      /* malformed claim – still worth reporting the presence */
    }
  }

  const actions: C2paAction[] = [];
  const assertionLabels = new Set<string>();
  for (const box of all) {
    if (box.label.startsWith('c2pa.assertions')) continue;
    if (box.label.startsWith('c2pa.actions') || box.label.startsWith('c2pa.action')) {
      try {
        actions.push(...actionsFromAssertion(box));
      } catch {
        /* ignore unreadable assertions */
      }
    }
  }
  for (const container of assertionBoxes) {
    for (const child of container.children ?? []) {
      if (child.label) assertionLabels.add(child.label);
    }
  }

  const sig = signatureBox ? signatureInfo(signatureBox) : {};
  const thumbnailBytes = thumbnailBox ? imagePayload(thumbnailBox) : null;
  const hasThumbnail = thumbnailBytes !== null;
  const thumbnail = thumbnailBytes
    ? {
        blob: new Blob([thumbnailBytes.slice()], { type: extensionToMime(thumbnailBox?.label ?? '') }),
        mime: extensionToMime(thumbnailBox?.label ?? ''),
      }
    : undefined;

  return {
    label: manifest.label || 'c2pa.manifest',
    bytes: manifest.length,
    claimGenerator,
    title,
    signer: sig.signer,
    issuer: sig.issuer,
    algorithm: sig.algorithm,
    certValidFrom: sig.validFrom,
    certValidTo: sig.validTo,
    actions,
    assertionLabels: [...assertionLabels],
    ingredientCount: all.filter((b) => b.label.startsWith('c2pa.ingredient')).length,
    hasThumbnail,
    thumbnail: thumbnail?.blob,
  };
}

/** Summarize every C2PA manifest reachable from a JUMBF tree. */
export function summarizeC2pa(boxes: readonly JumbfBox[], bytes: number): C2paSummary {
  const all = walkJumbf(boxes);
  const manifestBoxes = all.filter(
    (b) => b.label === 'c2pa.manifest' || b.label.startsWith('c2pa.manifest.'),
  );
  const manifests = manifestBoxes.map(summarizeManifest);
  const hasC2paBox = all.some((b) => b.label === 'c2pa' || b.label.startsWith('c2pa.'));
  return { present: hasC2paBox || manifests.length > 0, manifests, bytes, boxCount: all.length };
}
