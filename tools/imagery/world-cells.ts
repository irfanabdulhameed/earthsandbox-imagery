// The world layout (docs/imagery-tiles.md, "World layout, version 3"): one archive per level-6 cell of the game's
// cube-sphere, a base tier everywhere on land and a 10 m tier where people live and along coasts, chosen per level-9 tile.
// Pure geometry and the game's own maps (water-8k.webp for land and coast, people-4320.bin for people); no network.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import sharp from 'sharp';
import { POPGRID_FORMAT, popGridFromBody, readHeader } from '../../src/shared/popgrid-codec.ts';
import { dirToFace, dirToLatLon, faceToDir, latLonToDir, R_KM, tileAt, tileBounds } from './cube.ts';
import type { Zone } from './utm.ts';

const ROOT = new URL('../..', import.meta.url).pathname;

/** The shard cell's level, the base tier's finest level (38 m), the 10 m tier's (9.6 m), the level the 10 m tier is
 *  chosen at, and the root archive's levels (from the first that beats color-8k up to the cells). */
export const SHARD_LEVEL = 6;
export const BASE_MAX_LEVEL = 9;
export const FINE_MAX_LEVEL = 11;
export const FINE_PICK_LEVEL = 9;
export const ROOT_LEVELS = [3, 4, 5];
/** People per km² and km from the sea that put a level-9 tile in the 10 m tier. */
export const FINE_PEOPLE_PER_KM2 = 5;
export const FINE_COAST_KM = 10;
/** No photo south of this (Sentinel-2's systematic coverage starts at 56° S) or north of 84° N (UTM's end). */
export const SOUTH_LIMIT = -56;
export const NORTH_LIMIT = 84;

export const shardId = (face: number, x: number, y: number) => `f${face}-x${x}-y${y}`;
export function parseShardId(id: string): { face: number; x: number; y: number } {
  const m = /^f(\d)-x(\d+)-y(\d+)$/.exec(id);
  if (!m) throw new Error(`bad shard id ${id}`);
  return { face: Number(m[1]), x: Number(m[2]), y: Number(m[3]) };
}

/** Is a point inside tile (face, level, x, y)? */
export function insideTile(face: number, level: number, x: number, y: number, lat: number, lon: number): boolean {
  const p = dirToFace(latLonToDir(lat, lon));
  if (p.face !== face) return false;
  const t = tileAt(level, p.a, p.b);
  return t.x === x && t.y === y;
}

/** Points over a tile, k × k (centres of a k × k grid), as latitude and longitude. */
export function tilePoints(face: number, level: number, x: number, y: number, k: number): { lat: number; lon: number }[] {
  const { s, a0, b0 } = tileBounds(level, x, y);
  const out: { lat: number; lon: number }[] = [];
  for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) out.push(dirToLatLon(faceToDir(face, a0 + ((i + 0.5) * s) / k, b0 + ((j + 0.5) * s) / k)));
  return out;
}

/**
 * Latitude and longitude boxes [west, south, east, north] covering a tile, split at the antimeridian, whole in longitude
 * when it holds a pole. Edges and a margin of points are included.
 */
export function tileBoxes(face: number, level: number, x: number, y: number, marginDeg = 0.05): number[][] {
  const { s, a0, b0 } = tileBounds(level, x, y);
  const pts: { lat: number; lon: number }[] = [];
  const K = 24;
  for (let j = 0; j <= K; j++) for (let i = 0; i <= K; i++) pts.push(dirToLatLon(faceToDir(face, a0 + (i * s) / K, b0 + (j * s) / K)));
  let s0 = Math.min(...pts.map((p) => p.lat)) - marginDeg;
  let n0 = Math.max(...pts.map((p) => p.lat)) + marginDeg;
  // A pole inside the tile: every longitude.
  for (const pole of [90, -90]) {
    if (insideTile(face, level, x, y, pole, 0)) {
      if (pole > 0) n0 = 90;
      else s0 = -90;
      return [[-180, Math.max(-90, s0), 180, Math.min(90, n0)]];
    }
  }
  const lons = pts.map((p) => p.lon);
  const east = lons.filter((l) => l >= 0);
  const west = lons.filter((l) => l < 0);
  const box = (lo: number, hi: number) => [Math.max(-180, lo - marginDeg), Math.max(-90, s0), Math.min(180, hi + marginDeg), Math.min(90, n0)];
  if (east.length && west.length && Math.max(...east) - Math.min(...west) > 180) {
    // Across the antimeridian: two boxes.
    return [box(Math.min(...east), 180), box(-180, Math.max(...west))];
  }
  return [box(Math.min(...lons), Math.max(...lons))];
}

/** The UTM zone Sentinel-2 uses at a point (with the Norway and Svalbard exceptions of MGRS). */
export function s2Zone(lat: number, lon: number): Zone {
  let zone = Math.floor((lon + 180) / 6) + 1;
  if (zone > 60) zone = 60;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;
  if (lat >= 72 && lat < 84) {
    if (lon >= 0 && lon < 9) zone = 31;
    else if (lon >= 9 && lon < 21) zone = 33;
    else if (lon >= 21 && lon < 33) zone = 35;
    else if (lon >= 33 && lon < 42) zone = 37;
  }
  return { zone, south: lat < 0 };
}

/** Km from a point to the edge of a zone's area (positive inside, negative outside), across longitude and the equator. */
export function zoneEdgeKm(z: Zone, lat: number, lon: number): number {
  // The zone's longitudes at this latitude (the exceptions move them).
  let lo = -180 + (z.zone - 1) * 6;
  let hi = lo + 6;
  if (lat >= 56 && lat < 64) {
    if (z.zone === 31) hi = 3;
    if (z.zone === 32) lo = 3;
  }
  if (lat >= 72 && lat < 84) {
    const special: Record<number, [number, number]> = { 31: [0, 9], 33: [9, 21], 35: [21, 33], 37: [33, 42] };
    if (special[z.zone]) [lo, hi] = special[z.zone];
    else if ([32, 34, 36].includes(z.zone)) [lo, hi] = [0, 0];
  }
  const kmLon = 111.32 * Math.cos((lat * Math.PI) / 180);
  let dl = Math.min(lon - lo, hi - lon);
  // Longitudes wrap at the antimeridian.
  if (z.zone === 1 && lon > 174) dl = Math.min(hi - (lon - 360), lon - 360 - lo);
  if (z.zone === 60 && lon < -174) dl = Math.min(lon + 360 - lo, hi - (lon + 360));
  const dLat = z.south ? -lat : lat;
  return Math.min(dl * kmLon, dLat * 111.32);
}

export interface WorldMaps {
  /** Land (true) at a point, and km from the coast (positive at sea, negative inland; ±12 km at most). */
  coastKm(lat: number, lon: number): number;
  /** People per km² (GHS-POP 2025 at 1/12°). */
  peoplePerKm2(lat: number, lon: number): number;
}

export async function loadWorldMaps(): Promise<WorldMaps> {
  const water = await sharp(join(ROOT, 'public/earth/water-8k.webp')).extractChannel(0).raw().toBuffer();
  const WW = 8192;
  const WH = 4096;
  const file = new Uint8Array(readFileSync(join(ROOT, 'public/earth', POPGRID_FORMAT.file)));
  const pop = popGridFromBody(readHeader(file), new Uint8Array(inflateRawSync(file.subarray(POPGRID_FORMAT.headerBytes))));
  const lut = Array.from({ length: 256 }, (_, q) => (q ? POPGRID_FORMAT.pMin * (POPGRID_FORMAT.pMax / POPGRID_FORMAT.pMin) ** ((q - 1) / 254) : 0));
  const cellArea = new Float64Array(pop.height);
  for (let r = 0; r < pop.height; r++) {
    const la = ((90 - (r / pop.height) * 180) * Math.PI) / 180;
    const lb = ((90 - ((r + 1) / pop.height) * 180) * Math.PI) / 180;
    cellArea[r] = R_KM * R_KM * ((2 * Math.PI) / pop.width) * Math.abs(Math.sin(la) - Math.sin(lb));
  }
  return {
    coastKm(lat, lon) {
      // water-8k: the signed distance to the coast, water positive, 0.5 at the coast and ±12 km at 0 and 1; bilinear.
      const fx = ((lon + 180) / 360) * WW - 0.5;
      const fy = ((90 - lat) / 180) * WH - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.max(0, Math.min(WH - 2, Math.floor(fy)));
      const tx = fx - x0;
      const ty = Math.max(0, Math.min(1, fy - y0));
      const g = (x: number, y: number) => water[y * WW + (((x % WW) + WW) % WW)];
      const v = (g(x0, y0) * (1 - tx) + g(x0 + 1, y0) * tx) * (1 - ty) + (g(x0, y0 + 1) * (1 - tx) + g(x0 + 1, y0 + 1) * tx) * ty;
      return (v / 255 - 0.5) * 2 * 12;
    },
    peoplePerKm2(lat, lon) {
      const px = Math.min(pop.width - 1, Math.max(0, Math.floor(((lon + 180) / 360) * pop.width)));
      const py = Math.min(pop.height - 1, Math.max(0, Math.floor(((90 - lat) / 180) * pop.height)));
      return lut[pop.people[py * pop.width + px]] / cellArea[py];
    },
  };
}

/** Greenland's ice and Antarctica take the base tier only (Greenland's box; Antarctica is past the south limit anyway). */
export const isIceSheet = (lat: number, lon: number) => lat < -60 || (lat > 59.5 && lon > -74 && lon < -10 && !(lat < 61 && lon > -45));

export interface ShardSpec {
  id: string;
  face: number;
  x: number;
  y: number;
  /** Share of the cell that is land (within the photo's latitudes). */
  land: number;
  /** Level-9 tiles in the 10 m tier, as a 64-bit mask over the cell's 8 × 8 level-9 tiles (16 hex digits; bit
   *  `(y9 % 8) * 8 + (x9 % 8)`). */
  fine: string;
  fineCount: number;
  lat: number;
  lon: number;
  /** Snow counts as clear here (ice sheets, the high Arctic). */
  snow: boolean;
  /** Dry runs only: build the 10 m blocks nearest this point first (latitude, longitude). */
  focus?: [number, number];
  /** T2 only: the block's picked level-9 tiles, and the index of its Pages project in the T2 plan. */
  tiles?: { x: number; y: number }[];
  project?: number;
}

const usable = (lat: number) => lat >= SOUTH_LIMIT && lat <= NORTH_LIMIT;

/** One cell's spec, or null when it holds no land the photo covers. */
export function cellSpec(maps: WorldMaps, face: number, x: number, y: number): ShardSpec | null {
  const pts = tilePoints(face, SHARD_LEVEL, x, y, 24);
  let land = 0;
  for (const p of pts) if (usable(p.lat) && maps.coastKm(p.lat, p.lon) < 0.5) land++;
  if (!land) return null;
  const centre = dirToLatLon(faceToDir(face, ...(() => {
    const b = tileBounds(SHARD_LEVEL, x, y);
    return [b.a0 + b.s / 2, b.b0 + b.s / 2] as [number, number];
  })()));
  // The 10 m tier, per level-9 tile: any point of it on land with people, or on land near the sea, and not ice.
  const per = 2 ** (FINE_PICK_LEVEL - SHARD_LEVEL);
  let mask = 0n;
  let count = 0;
  for (let j = 0; j < per; j++)
    for (let i = 0; i < per; i++) {
      const x9 = x * per + i;
      const y9 = y * per + j;
      const fine = tilePoints(face, FINE_PICK_LEVEL, x9, y9, 9).some((p) => {
        if (!usable(p.lat) || isIceSheet(p.lat, p.lon)) return false;
        const c = maps.coastKm(p.lat, p.lon);
        if (c >= 0.5) return false;
        return c > -FINE_COAST_KM || maps.peoplePerKm2(p.lat, p.lon) >= FINE_PEOPLE_PER_KM2;
      });
      if (fine) {
        mask |= 1n << BigInt(j * 8 + i);
        count++;
      }
    }
  const snow = Math.abs(centre.lat) >= 60 || pts.some((p) => isIceSheet(p.lat, p.lon));
  return {
    id: shardId(face, x, y),
    face,
    x,
    y,
    land: land / pts.length,
    fine: mask.toString(16).padStart(16, '0'),
    fineCount: count,
    lat: +centre.lat.toFixed(4),
    lon: +centre.lon.toFixed(4),
    snow,
  };
}

/** The level-9 tiles of a spec's 10 m tier. */
export function fineTiles(spec: ShardSpec): { x: number; y: number }[] {
  const mask = BigInt(`0x${spec.fine}`);
  const per = 2 ** (FINE_PICK_LEVEL - SHARD_LEVEL);
  const out: { x: number; y: number }[] = [];
  for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) if ((mask >> BigInt(j * 8 + i)) & 1n) out.push({ x: spec.x * per + i, y: spec.y * per + j });
  return out;
}

/** Every cell of the world with land, in a fixed order (face, y, x). */
export function worldSpecs(maps: WorldMaps): ShardSpec[] {
  const n = 2 ** SHARD_LEVEL;
  const out: ShardSpec[] = [];
  for (let face = 0; face < 6; face++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const s = cellSpec(maps, face, x, y);
    if (s) out.push(s);
  }
  return out;
}

/** The cell holding a point. */
export function cellAt(lat: number, lon: number): { face: number; x: number; y: number } {
  const p = dirToFace(latLonToDir(lat, lon));
  return { face: p.face, ...tileAt(SHARD_LEVEL, p.a, p.b) };
}

/**
 * The dates to search, by latitude: the local summer away from the tropics (no snow, long days), the whole of 2025 in
 * the tropics (the composite keeps the clearest, least hazy dates, which fall in the dry season).
 */
export function seasonFor(lat: number): [string, string][] {
  if (lat >= 35) return lat >= 60 ? [['2025-06-01', '2025-08-31']] : [['2025-05-15', '2025-09-15']];
  if (lat <= -35) return [['2024-11-15', '2025-03-15'], ['2025-11-15', '2026-03-15']];
  return [['2025-01-01', '2025-12-31']];
}
