import { describe, expect, it } from 'vitest';

import { summarizeC2pa } from '../src/core/c2pa.ts';
import { parseJumbf } from '../src/core/jumbf.ts';

const enc = new TextEncoder();

function u32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function box(type: string, payload: Uint8Array): Uint8Array {
  return concat([u32(8 + payload.length), enc.encode(type), payload]);
}

/** `jumd` payload: 16-byte UUID, toggle byte, NUL terminated label. */
function jumd(label: string, tag: number, toggles = 3): Uint8Array {
  const uuid = new Uint8Array(16);
  uuid[0] = (tag >>> 24) & 0xff;
  uuid[1] = (tag >>> 16) & 0xff;
  uuid[2] = (tag >>> 8) & 0xff;
  uuid[3] = tag & 0xff;
  return box(
    'jumd',
    concat([uuid, new Uint8Array([toggles]), enc.encode(label), new Uint8Array([0])]),
  );
}

function superbox(label: string, tag: number, children: Uint8Array[]): Uint8Array {
  return box('jumb', concat([jumd(label, tag), ...children]));
}

function cborText(text: string): Uint8Array {
  const body = enc.encode(text);
  return concat([new Uint8Array([0x60 | body.length]), body]);
}

function cborMap(entries: [string, Uint8Array][]): Uint8Array {
  return concat([
    new Uint8Array([0xa0 | entries.length]),
    ...entries.flatMap(([key, value]) => [cborText(key), value]),
  ]);
}

function cborArray(items: Uint8Array[]): Uint8Array {
  return concat([new Uint8Array([0x80 | items.length]), ...items]);
}

const STORE = 0x63327061; // 'c2pa'
const MANIFEST = 0x63326d61; // 'c2ma'
const ASSERTIONS = 0x63326173; // 'c2as'
const CLAIM = 0x6332636c; // 'c2cl'
const ACTIONS = 0x63626f72; // 'cbor'

const claim = cborMap([
  [
    'claim_generator_info',
    // C2PA 2.x writes a single map here; 1.x wrote a list of them.
    cborMap([
      ['name', cborText('GPT-4o')],
      ['version', cborText('2.0.0')],
    ]),
  ],
  ['dc:title', cborText('t.png')],
]);

const actions = cborMap([
  ['actions', cborArray([cborMap([['action', cborText('c2pa.created')]])])],
]);

const claimBox = superbox('c2pa.claim.v2', CLAIM, [box('cbor', claim)]);

describe('C2PA manifests', () => {
  it('finds a C2PA 2.x manifest labelled urn:c2pa:<uuid>', () => {
    const manifest = superbox('urn:c2pa:3b2b28e8-480a-4dc1-89ea-966b400e0eed', MANIFEST, [
      superbox('c2pa.assertions', ASSERTIONS, [
        superbox('c2pa.actions.v2', ACTIONS, [box('cbor', actions)]),
      ]),
      claimBox,
    ]);
    const store = superbox('c2pa', STORE, [manifest]);

    const summary = summarizeC2pa(parseJumbf(store), store.length);
    expect(summary.present).toBe(true);
    expect(summary.manifests).toHaveLength(1);

    const found = summary.manifests[0];
    expect(found?.label).toBe('urn:c2pa:3b2b28e8-480a-4dc1-89ea-966b400e0eed');
    expect(found?.claimGenerator).toBe('GPT-4o 2.0.0');
    expect(found?.title).toBe('t.png');
    expect(found?.actions.map((action) => action.action)).toEqual(['c2pa.created']);
    expect(found?.assertionLabels).toContain('c2pa.actions.v2');
  });

  it('keeps reading the 1.x c2pa.manifest label, without counting its jumd', () => {
    const store = superbox('c2pa', STORE, [superbox('c2pa.manifest', MANIFEST, [claimBox])]);

    const summary = summarizeC2pa(parseJumbf(store), store.length);
    expect(summary.manifests).toHaveLength(1);
    expect(summary.manifests[0]?.label).toBe('c2pa.manifest');
    expect(summary.manifests[0]?.claimGenerator).toBe('GPT-4o 2.0.0');
  });
});
