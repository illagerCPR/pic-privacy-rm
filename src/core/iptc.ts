/** Photoshop APP13 / IPTC-IIM reader. */
import { decodeText, startsWithBytes, u16be, u32be } from './bytes.ts';
import type { Field } from './types.ts';

export interface IptcResource {
  id: number;
  name: string;
  bytes: number;
}

export interface IptcSummary {
  bytes: number;
  resources: IptcResource[];
  datasets: { key: string; name: string; value: string }[];
  fields: Field[];
}

const RESOURCE_NAMES: Record<number, string> = {
  0x03e8: 'MeSa',
  0x03ed: 'ResolutionInfo',
  0x03ee: 'Alpha channels',
  0x03ef: 'DisplayInfo',
  0x03f2: 'Caption digest',
  0x03f3: 'Print flags',
  0x0404: 'IPTC-NAA',
  0x0409: 'Thumbnail resource',
  0x040a: 'Copyright flag',
  0x040c: 'Thumbnail (old)',
  0x0410: 'URL',
  0x0411: 'Global angle',
  0x0414: 'ICC profile (untagged)',
  0x0421: 'Version info',
  0x0422: 'EXIF data 1',
  0x0423: 'EXIF data 3',
  0x0424: 'XMP metadata',
  0x0425: 'Caption digest',
  0x0426: 'Print scale',
  0x0428: 'Pixel aspect ratio',
  0x042b: 'Alternate duotone colours',
  0x042d: 'Layer selection ids',
  0x042f: 'Layer groups enabled id',
  0x04f3: 'Seed number',
  0x04f6: 'URL list',
  0x0bb7: 'Clipping path name',
  0x2710: 'Print flags info',
};

const IIM_NAMES: Record<string, string> = {
  '1:5': 'ObjectName',
  '1:90': 'CodedCharacterSet',
  '2:5': 'ObjectName',
  '2:7': 'EditStatus',
  '2:10': 'Urgency',
  '2:12': 'Subject',
  '2:15': 'Category',
  '2:20': 'SupplementalCategories',
  '2:22': 'FixtureID',
  '2:25': 'Keywords',
  '2:26': 'ContentLocationCode',
  '2:27': 'ContentLocationName',
  '2:30': 'ReleaseDate',
  '2:35': 'ReleaseTime',
  '2:40': 'SpecialInstructions',
  '2:45': 'ReferenceService',
  '2:47': 'ReferenceDate',
  '2:50': 'ReferenceNumber',
  '2:55': 'DateCreated',
  '2:60': 'TimeCreated',
  '2:62': 'DigitalCreationDate',
  '2:63': 'DigitalCreationTime',
  '2:65': 'OriginatingProgram',
  '2:70': 'ProgramVersion',
  '2:75': 'ObjectCycle',
  '2:80': 'Byline',
  '2:85': 'BylineTitle',
  '2:90': 'City',
  '2:92': 'SubLocation',
  '2:95': 'ProvinceState',
  '2:100': 'CountryCode',
  '2:101': 'CountryName',
  '2:103': 'OriginalTransmissionReference',
  '2:105': 'Headline',
  '2:110': 'Credit',
  '2:115': 'Source',
  '2:116': 'CopyrightNotice',
  '2:118': 'Contact',
  '2:120': 'Caption',
  '2:122': 'Writer',
  '2:125': 'RasterizedCaption',
  '2:130': 'ImageType',
  '2:131': 'ImageOrientation',
  '2:135': 'LanguageID',
  '2:150': 'AudioType',
  '2:200': 'ObjectPreviewFileFormat',
};

function readPascalName(data: Uint8Array, offset: number): { name: string; next: number } {
  if (offset >= data.length) return { name: '', next: offset };
  const len = data[offset] ?? 0;
  const end = offset + 1 + len;
  const name = decodeText(data.subarray(offset + 1, Math.min(end, data.length))).trim();
  const padded = (1 + len) % 2 === 0 ? end : end + 1;
  return { name, next: padded };
}

export type IptcDataset = { key: string; name: string; value: string };

function fieldsFor(datasets: IptcDataset[]): Field[] {
  return datasets.map((d) => ({
    label: `IPTC ${d.name}`,
    value: d.value,
    group:
      /City|Country|Location|Province|Date|Time|Byline|Credit|Copyright|Caption|Headline|Writer|Contact|Source|Keywords|ObjectName/.test(
        d.name,
      )
        ? 'author'
        : 'other',
    sensitive: true,
  }));
}

/** Read an IPTC-IIM record stream (the payload of TIFF tag 0x83bb, or 8BIM 0x0404). */
export function parseIptcIim(iim: Uint8Array): IptcDataset[] {
  const datasets: IptcDataset[] = [];
  let p = 0;
  while (p + 5 <= iim.length) {
    if (iim[p] !== 0x1c) break;
    const record = iim[p + 1] ?? 0;
    const dataset = iim[p + 2] ?? 0;
    const len = u16be(iim, p + 3);
    const body = iim.subarray(p + 5, Math.min(iim.length, p + 5 + len));
    const key = `${record}:${dataset}`;
    const text = decodeText(body)
      .replace(/\u0000/g, '')
      .trim();
    if (text) datasets.push({ key, name: IIM_NAMES[key] ?? key, value: text.slice(0, 400) });
    p += 5 + len;
  }
  return datasets;
}

/** Parse a Photoshop image-resource stream (8BIM blocks, without the `Photoshop 3.0` header). */
export function parsePhotoshopResources(stream: Uint8Array): IptcSummary | null {
  const resources: IptcResource[] = [];
  const datasets: IptcDataset[] = [];
  let pos = 0;

  while (pos + 12 <= stream.length) {
    const signature = decodeText(stream.subarray(pos, pos + 4));
    if (
      signature !== '8BIM' &&
      signature !== 'PHUT' &&
      signature !== 'AgHg' &&
      signature !== 'DCSR'
    )
      break;
    const id = u16be(stream, pos + 4);
    const { name, next } = readPascalName(stream, pos + 6);
    const sizeOffset = next;
    if (sizeOffset + 4 > stream.length) break;
    const size = u32be(stream, sizeOffset);
    const dataStart = sizeOffset + 4;
    const dataEnd = Math.min(stream.length, dataStart + size);
    resources.push({ id, name: name || RESOURCE_NAMES[id] || `0x${id.toString(16)}`, bytes: size });

    if (id === 0x0404) datasets.push(...parseIptcIim(stream.subarray(dataStart, dataEnd)));

    pos = dataStart + size + (size % 2);
  }

  if (resources.length === 0 && !startsWithBytes(stream, 0, '8BIM')) return null;
  return { bytes: stream.length, resources, datasets, fields: fieldsFor(datasets) };
}

export function parsePhotoshopApp13(payload: Uint8Array): IptcSummary | null {
  if (!startsWithBytes(payload, 0, 'Photoshop')) return null;
  // Skip "Photoshop 3.0\0"
  const nul = payload.indexOf(0);
  const body = payload.subarray(nul >= 0 ? nul + 1 : 14);
  const summary = parsePhotoshopResources(body);
  if (!summary) return null;
  return { ...summary, bytes: payload.length };
}

/** Summarise a bare IPTC-IIM stream, as stored in TIFF tag 0x83bb. */
export function summarizeIim(iim: Uint8Array): IptcSummary {
  const datasets = parseIptcIim(iim);
  return { bytes: iim.length, resources: [], datasets, fields: fieldsFor(datasets) };
}
