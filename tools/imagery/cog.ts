// A small reader for cloud-optimised GeoTIFFs over HTTP: it reads the header, then only the internal tiles a window
// needs, each with one Range request. Enough for the Sentinel-2 COGs (tiled, deflate, horizontal predictor, 8 or
// 16-bit, one band); anything else is refused with a clear error. Nothing is written to disk: the bytes are decoded in
// memory and dropped.

import { inflate } from 'node:zlib';
import { promisify } from 'node:util';

const inflateAsync = promisify(inflate);

export const stats = { requests: 0, bytes: 0, retries: 0 };

// A simple limit on requests in flight.
let active = 0;
const waiting: (() => void)[] = [];
let limit = 24;
export const setConcurrency = (n: number) => (limit = n);
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= limit) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** GET a byte range (inclusive start, length bytes), retrying network errors and 5xx answers. */
export async function getRange(url: string, start: number, length: number): Promise<Uint8Array> {
  return slot(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, { headers: { Range: `bytes=${start}-${start + length - 1}` } });
        if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status} for ${url}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        stats.requests++;
        stats.bytes += buf.length;
        // A server that ignores Range sends the whole file: keep only the asked part.
        return res.status === 200 ? buf.subarray(start, start + length) : buf;
      } catch (err) {
        if (attempt >= 5 || /HTTP 4\d\d/.test(String(err))) throw err;
        stats.retries++;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  });
}

export interface Ifd {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  bitsPerSample: number;
  compression: number;
  predictor: number;
  offsets: number[];
  counts: number[];
  tilesAcross: number;
}

export interface Cog {
  url: string;
  ifds: Ifd[];
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };

/** Reads and parses a COG's header: every IFD (full resolution first, then the overviews). */
export async function openCog(url: string): Promise<Cog> {
  let head = await getRange(url, 0, 65536);
  const ensure = async (end: number) => {
    if (end <= head.length) return;
    const more = await getRange(url, head.length, Math.max(end - head.length, 65536));
    const joined = new Uint8Array(head.length + more.length);
    joined.set(head);
    joined.set(more, head.length);
    head = joined;
  };
  const view = () => new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head[0] !== 0x49 || head[1] !== 0x49) throw new Error(`${url}: only little-endian TIFF is supported`);
  const big = view().getUint16(2, true) === 43;
  const u = (off: number, size: number) => {
    const v = view();
    return size === 1 ? v.getUint8(off) : size === 2 ? v.getUint16(off, true) : size === 4 ? v.getUint32(off, true) : Number(v.getBigUint64(off, true));
  };
  let next = big ? u(8, 8) : u(4, 4);
  const ifds: Ifd[] = [];
  while (next) {
    await ensure(next + 8);
    const count = big ? u(next, 8) : u(next, 2);
    const entrySize = big ? 20 : 12;
    const first = next + (big ? 8 : 2);
    await ensure(first + count * entrySize + 8);
    const tags = new Map<number, number[]>();
    for (let k = 0; k < count; k++) {
      const e = first + k * entrySize;
      const tag = u(e, 2);
      const type = u(e + 2, 2);
      const n = big ? u(e + 4, 8) : u(e + 4, 4);
      const size = TYPE_SIZE[type] ?? 1;
      if (![3, 4, 16].includes(type) && ![324, 325, 322, 323, 256, 257].includes(tag)) continue;
      const inline = n * size <= (big ? 8 : 4);
      let at = inline ? e + (big ? 12 : 8) : big ? u(e + 12, 8) : u(e + 8, 4);
      if (!inline) await ensure(at + n * size);
      const values: number[] = [];
      for (let i = 0; i < n; i++, at += size) values.push(u(at, size));
      tags.set(tag, values);
    }
    next = big ? u(first + count * entrySize, 8) : u(first + count * entrySize, 4);
    const g = (t: number, d?: number) => {
      const v = tags.get(t)?.[0] ?? d;
      if (v === undefined) throw new Error(`${url}: TIFF tag ${t} missing`);
      return v;
    };
    if (!tags.has(322)) throw new Error(`${url}: not a tiled TIFF`);
    const width = g(256);
    const tileWidth = g(322);
    const ifd: Ifd = {
      width,
      height: g(257),
      tileWidth,
      tileHeight: g(323),
      bitsPerSample: g(258),
      compression: g(259),
      predictor: g(317, 1),
      offsets: tags.get(324) ?? [],
      counts: tags.get(325) ?? [],
      tilesAcross: Math.ceil(width / tileWidth),
    };
    if (g(277, 1) !== 1) throw new Error(`${url}: one band per file expected`);
    if (![1, 8, 32946].includes(ifd.compression)) throw new Error(`${url}: compression ${ifd.compression} not supported`);
    if (![8, 16].includes(ifd.bitsPerSample)) throw new Error(`${url}: ${ifd.bitsPerSample}-bit not supported`);
    ifds.push(ifd);
  }
  return { url, ifds };
}

// Headers already read, shared by the composite and the water passes of one shard. A long run builds hundreds of shards
// in one process, so the runner empties it after each (forgetCogs); a header that failed to load is not kept.
const opened = new Map<string, Promise<Cog>>();

/** A COG's header, read once while a shard is being built. */
export function cachedCog(url: string): Promise<Cog> {
  let c = opened.get(url);
  if (!c) {
    const p = openCog(url);
    p.catch(() => {
      if (opened.get(url) === p) opened.delete(url);
    });
    opened.set(url, (c = p));
  }
  return c;
}

/** Drops every cached header (after each shard). */
export const forgetCogs = () => opened.clear();

/** Decodes one internal tile to its samples (row-major, tileWidth × tileHeight). Missing tiles are all zero. */
export async function readTile(cog: Cog, level: number, tx: number, ty: number): Promise<Uint16Array | Uint8Array> {
  const ifd = cog.ifds[level];
  const k = ty * ifd.tilesAcross + tx;
  const n = ifd.tileWidth * ifd.tileHeight;
  const empty = ifd.bitsPerSample === 16 ? new Uint16Array(n) : new Uint8Array(n);
  if (!ifd.counts[k]) return empty;
  const raw = await getRange(cog.url, ifd.offsets[k], ifd.counts[k]);
  const bytes = ifd.compression === 1 ? raw : new Uint8Array(await inflateAsync(raw));
  const w = ifd.tileWidth;
  if (ifd.bitsPerSample === 16) {
    const out = new Uint16Array(n);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < Math.min(n, bytes.length >> 1); i++) out[i] = dv.getUint16(i * 2, true);
    if (ifd.predictor === 2) for (let r = 0; r < ifd.tileHeight; r++) for (let c = 1, o = r * w; c < w; c++) out[o + c] = (out[o + c] + out[o + c - 1]) & 0xffff;
    return out;
  }
  const out = new Uint8Array(n);
  out.set(bytes.subarray(0, n));
  if (ifd.predictor === 2) for (let r = 0; r < ifd.tileHeight; r++) for (let c = 1, o = r * w; c < w; c++) out[o + c] = (out[o + c] + out[o + c - 1]) & 0xff;
  return out;
}

/**
 * Reads a window [x0, x0+w) × [y0, y0+h) of one IFD into a new array. Parts outside the image are zero (nodata in the
 * Sentinel-2 files).
 */
export async function readWindow(cog: Cog, level: number, x0: number, y0: number, w: number, h: number): Promise<Uint16Array | Uint8Array> {
  const ifd = cog.ifds[level];
  const out = ifd.bitsPerSample === 16 ? new Uint16Array(w * h) : new Uint8Array(w * h);
  const tx0 = Math.max(0, Math.floor(x0 / ifd.tileWidth));
  const ty0 = Math.max(0, Math.floor(y0 / ifd.tileHeight));
  const tx1 = Math.min(ifd.tilesAcross - 1, Math.floor((x0 + w - 1) / ifd.tileWidth));
  const ty1 = Math.min(Math.ceil(ifd.height / ifd.tileHeight) - 1, Math.floor((y0 + h - 1) / ifd.tileHeight));
  const jobs: Promise<void>[] = [];
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++)
      jobs.push(
        readTile(cog, level, tx, ty).then((tile) => {
          const ox = tx * ifd.tileWidth;
          const oy = ty * ifd.tileHeight;
          const cx0 = Math.max(x0, ox);
          const cx1 = Math.min(x0 + w, ox + ifd.tileWidth, ifd.width);
          const cy0 = Math.max(y0, oy);
          const cy1 = Math.min(y0 + h, oy + ifd.tileHeight, ifd.height);
          for (let y = cy0; y < cy1; y++) {
            const src = (y - oy) * ifd.tileWidth + (cx0 - ox);
            out.set(tile.subarray(src, src + (cx1 - cx0)), (y - y0) * w + (cx0 - x0));
          }
        }),
      );
  await Promise.all(jobs);
  return out;
}
