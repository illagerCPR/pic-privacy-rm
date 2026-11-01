/** Turn raw GPS IFD tags into human coordinates and display fields. */
import { getIfd, type TiffIfd, type TiffResult } from './tiff.ts';
import type { Field } from './types.ts';

export interface GpsInfo {
  lat: number;
  lon: number;
  fields: Field[];
  /** Language-neutral coordinate strings, e.g. `35.689300° N`. */
  latText: string;
  lonText: string;
  mapUrl: string;
}

function rational(nums: number[], index: number): number {
  const num = nums[index * 2] ?? 0;
  const den = nums[index * 2 + 1] ?? 1;
  return den === 0 ? 0 : num / den;
}

function dmsToDecimal(nums: number[]): number | undefined {
  if (nums.length < 2) return undefined;
  const deg = rational(nums, 0);
  const min = rational(nums, 1);
  const sec = nums.length >= 6 ? rational(nums, 2) : 0;
  const value = deg + min / 60 + sec / 3600;
  return Number.isFinite(value) ? value : undefined;
}

function textOf(tags: Map<number, TiffIfd['tags'][number]>, tag: number): string {
  return tags.get(tag)?.value.text?.trim().toUpperCase() ?? '';
}

function decodeUserData(raw: Uint8Array): string {
  const prefix = new TextDecoder('ascii').decode(raw.subarray(0, 8));
  const body = raw.subarray(8);
  if (prefix.startsWith('ASCII')) return new TextDecoder('utf-8', { fatal: false }).decode(body).replace(/\u0000/g, '').trim();
  if (prefix.startsWith('UNICODE')) {
    let s = '';
    for (let i = 0; i + 1 < body.length; i += 2) {
      s += String.fromCharCode((body[i] ?? 0) | ((body[i + 1] ?? 0) << 8));
    }
    return s.replace(/\u0000/g, '').trim();
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(raw).replace(/\u0000/g, '').trim();
}

export function describeGps(ifd: TiffIfd): GpsInfo | null {
  const tags = new Map<number, TiffIfd['tags'][number]>();
  for (const t of ifd.tags) tags.set(t.tag, t);

  const lat = dmsToDecimal(tags.get(0x0002)?.value.nums ?? []);
  const lon = dmsToDecimal(tags.get(0x0004)?.value.nums ?? []);
  if (lat === undefined || lon === undefined) return null;

  const latRef = textOf(tags, 0x0001) || 'N';
  const lonRef = textOf(tags, 0x0003) || 'E';
  const signedLat = latRef === 'S' ? -lat : lat;
  const signedLon = lonRef === 'W' ? -lon : lon;

  const fields: Field[] = [
    { label: 'GPSLatitude', value: `${signedLat.toFixed(6)}°`, group: 'gps', sensitive: true },
    { label: 'GPSLongitude', value: `${signedLon.toFixed(6)}°`, group: 'gps', sensitive: true },
  ];

  const altTag = tags.get(0x0006);
  if (altTag) {
    const alt = rational(altTag.value.nums, 0);
    const below = (tags.get(0x0005)?.value.nums[0] ?? 0) === 1;
    if (Number.isFinite(alt) && alt !== 0) {
      fields.push({
        label: 'GPSAltitude',
        value: `${below ? '-' : ''}${alt.toFixed(1)} m`,
        group: 'gps',
        sensitive: true,
      });
    }
  }

  const timeTag = tags.get(0x0007);
  const dateText = tags.get(0x001d)?.value.text?.trim();
  if (timeTag && timeTag.value.nums.length >= 4) {
    const h = Math.floor(rational(timeTag.value.nums, 0));
    const m = Math.floor(rational(timeTag.value.nums, 1));
    const s = Math.round(rational(timeTag.value.nums, 2));
    const clock = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    fields.push({
      label: 'GPSTimeStamp',
      value: dateText ? `${dateText.replace(/:/g, '-')} ${clock} UTC` : `${clock} UTC`,
      group: 'gps',
      sensitive: true,
    });
  } else if (dateText) {
    fields.push({ label: 'GPSDateStamp', value: dateText.replace(/:/g, '-'), group: 'gps', sensitive: true });
  }

  const speedTag = tags.get(0x000d);
  if (speedTag) {
    const speed = rational(speedTag.value.nums, 0);
    const ref = textOf(tags, 0x000c) || 'K';
    const unit = ref === 'M' ? 'mph' : ref === 'N' ? 'kn' : 'km/h';
    if (Number.isFinite(speed)) {
      fields.push({ label: 'GPSSpeed', value: `${speed.toFixed(1)} ${unit}`, group: 'gps', sensitive: true });
    }
  }

  const dirTag = tags.get(0x0011);
  if (dirTag) {
    const dir = rational(dirTag.value.nums, 0);
    const ref = textOf(tags, 0x0010) || 'T';
    if (Number.isFinite(dir)) {
      fields.push({
        label: 'GPSImgDirection',
        value: `${dir.toFixed(1)}° (${ref === 'M' ? 'magnetic' : 'true'} north)`,
        group: 'gps',
        sensitive: true,
      });
    }
  }

  for (const [tag, label] of [
    [0x001b, 'GPSProcessingMethod'],
    [0x001c, 'GPSAreaInformation'],
  ] as const) {
    const raw = tags.get(tag)?.value.bytes;
    if (!raw) continue;
    const text = decodeUserData(raw);
    if (text) fields.push({ label, value: text, group: 'gps', sensitive: true });
  }

  return {
    lat: signedLat,
    lon: signedLon,
    fields,
    latText: `${Math.abs(signedLat).toFixed(6)}° ${latRef}`,
    lonText: `${Math.abs(signedLon).toFixed(6)}° ${lonRef}`,
    mapUrl: `https://www.openstreetmap.org/?mlat=${signedLat.toFixed(6)}&mlon=${signedLon.toFixed(
      6,
    )}#map=16/${signedLat.toFixed(5)}/${signedLon.toFixed(5)}`,
  };
}

export function findGpsIfd(tiff: TiffResult): TiffIfd | undefined {
  return getIfd(tiff, 'gps');
}
