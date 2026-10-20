// The photo map archive: one file per region, read with HTTP Range requests. The layout is the contract in
// docs/imagery-tiles.md (header, metadata JSON, a sorted index of 20-byte entries, then the tile images).

import { morton } from './cube.ts';

export const MAGIC = 'ESPHOTO1';
export const VERSION = 2;
export const HEADER_BYTES = 64;
export const ENTRY_BYTES = 20;
export const FLAG_OPAQUE = 1;
export const FLAG_ALPHA = 2;
/** Version 2: the tile holds some water (alpha below the shore value). */
export const FLAG_WATER = 4;

export interface TileEntry {
  face: number;
  level: number;
  x: number;
  y: number;
  flags: number;
  offset: number;
  length: number;
}

export const tileKey = (face: number, level: number, x: number, y: number) => `${face}/${level}/${x}/${y}`;

/** The order of the index and of the data: level, face, then Morton order of (x, y). */
export function compareTiles(p: { face: number; level: number; x: number; y: number }, q: { face: number; level: number; x: number; y: number }): number {
  return p.level - q.level || p.face - q.face || morton(p.x, p.y) - morton(q.x, q.y);
}

/** Packs tiles (any order) into an archive. */
export function writeArchive(meta: Record<string, unknown>, tiles: { face: number; level: number; x: number; y: number; flags: number; data: Uint8Array }[]): Uint8Array {
  const sorted = [...tiles].sort(compareTiles);
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const metaOffset = HEADER_BYTES;
  const indexOffset = metaOffset + metaBytes.length;
  const indexLength = sorted.length * ENTRY_BYTES;
  const dataOffset = indexOffset + indexLength;
  const total = dataOffset + sorted.reduce((s, t) => s + t.data.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < MAGIC.length; i++) out[i] = MAGIC.charCodeAt(i);
  dv.setUint32(8, VERSION, true);
  dv.setUint32(12, metaOffset, true);
  dv.setUint32(16, metaBytes.length, true);
  dv.setUint32(20, indexOffset, true);
  dv.setUint32(24, indexLength, true);
  dv.setUint32(28, sorted.length, true);
  dv.setUint32(32, dataOffset, true);
  out.set(metaBytes, metaOffset);
  let at = dataOffset;
  sorted.forEach((t, k) => {
    const e = indexOffset + k * ENTRY_BYTES;
    dv.setUint8(e, t.face);
    dv.setUint8(e + 1, t.level);
    dv.setUint16(e + 2, t.flags, true);
    dv.setUint16(e + 4, t.x, true);
    dv.setUint16(e + 6, t.y, true);
    dv.setUint32(e + 8, at % 2 ** 32, true);
    dv.setUint32(e + 12, Math.floor(at / 2 ** 32), true);
    dv.setUint32(e + 16, t.data.length, true);
    out.set(t.data, at);
    at += t.data.length;
  });
  return out;
}

export interface ArchiveHead {
  meta: Record<string, unknown>;
  entries: TileEntry[];
  byKey: Map<string, TileEntry>;
}

/** Parses the start of an archive (at least header, metadata and index): the reader a renderer would use. */
export function readArchiveHead(bytes: Uint8Array): ArchiveHead {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  if (magic !== MAGIC) throw new Error('not a photo map archive');
  if (dv.getUint32(8, true) !== VERSION) throw new Error(`archive version ${dv.getUint32(8, true)}`);
  const metaOffset = dv.getUint32(12, true);
  const metaLength = dv.getUint32(16, true);
  const indexOffset = dv.getUint32(20, true);
  const count = dv.getUint32(28, true);
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(metaOffset, metaOffset + metaLength))) as Record<string, unknown>;
  const entries: TileEntry[] = [];
  const byKey = new Map<string, TileEntry>();
  for (let k = 0; k < count; k++) {
    const e = indexOffset + k * ENTRY_BYTES;
    const t: TileEntry = {
      face: dv.getUint8(e),
      level: dv.getUint8(e + 1),
      flags: dv.getUint16(e + 2, true),
      x: dv.getUint16(e + 4, true),
      y: dv.getUint16(e + 6, true),
      offset: dv.getUint32(e + 8, true) + dv.getUint32(e + 12, true) * 2 ** 32,
      length: dv.getUint32(e + 16, true),
    };
    entries.push(t);
    byKey.set(tileKey(t.face, t.level, t.x, t.y), t);
  }
  return { meta, entries, byKey };
}
