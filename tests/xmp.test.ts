import { describe, expect, it } from 'vitest';

import { parseXmp } from '../src/core/xmp.ts';

const XML = `<?xpacket begin='' id='W5M0MpCehiHzreSzNTczkc9d'?>
<x:xmpmeta xmlns:x='adobe:ns:meta/'>
 <rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>
  <rdf:Description xmlns:dc='http://purl.org/dc/elements/1.1/' xmlns:xmp='http://ns.adobe.com/xap/1.0/'>
   <dc:creator><rdf:Seq><rdf:li>Phil Harvey</rdf:li></rdf:Seq></dc:creator>
   <xmp:CreatorTool>ExifTool</xmp:CreatorTool>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function utf16(text: string, bigEndian: boolean, bom: boolean): Uint8Array {
  const bytes: number[] = [];
  if (bom) bytes.push(bigEndian ? 0xfe : 0xff, bigEndian ? 0xff : 0xfe);
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (bigEndian) bytes.push((code >> 8) & 0xff, code & 0xff);
    else bytes.push(code & 0xff, (code >> 8) & 0xff);
  }
  return new Uint8Array(bytes);
}

function summary(bytes: Uint8Array) {
  const xmp = parseXmp(bytes);
  return {
    namespaces: xmp.namespaces.length,
    creator: xmp.properties.find((property) => property.key === 'dc:creator')?.value,
    tool: xmp.properties.find((property) => property.key === 'xmp:CreatorTool')?.value,
    hasCreator: xmp.hasCreator,
  };
}

describe('XMP encoding', () => {
  it('reads a plain UTF-8 packet', () => {
    expect(summary(utf8(XML))).toMatchObject({
      creator: 'Phil Harvey',
      tool: 'ExifTool',
      hasCreator: true,
    });
  });

  it('reads a UTF-16 big-endian packet without a BOM', () => {
    // Real files do this: ExifTool's own XMP.jpg uses it to prove the case.
    expect(summary(utf16(XML, true, false))).toMatchObject({
      creator: 'Phil Harvey',
      tool: 'ExifTool',
    });
  });

  it('reads a UTF-16 little-endian packet with a BOM', () => {
    expect(summary(utf16(XML, false, true))).toMatchObject({
      creator: 'Phil Harvey',
      tool: 'ExifTool',
    });
  });

  it('does not mistake plain ASCII for UTF-16', () => {
    const xmp = parseXmp(utf8(XML));
    expect(xmp.namespaces.map((namespace) => namespace.prefix)).toContain('dc');
  });
});
