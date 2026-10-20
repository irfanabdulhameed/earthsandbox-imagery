// One shard of the world layout: the level-6 cell of the game's cube-sphere, as one archive (the version 2 binary format)
// with the base tier (levels 6–9, from the 40 m overviews of the bands) over all its land and the 10 m tier (levels
// 10–11) where its spec asks for it. A cell can cross UTM zones, the equator and the antimeridian: each zone (and
// hemisphere) gets its own composite on its own grid, and tiles mix them across zone edges over 6 km.
// Everything it downloads stays in memory or in its work folder, which is deleted when the shard is done.

import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { FLAG_ALPHA, FLAG_WATER, VERSION, writeArchive } from './archive.ts';
import { stats as netStats } from './cog.ts';
import { buildComposite, planComposite, resOf, type Composite, type Grid, type Plan } from './composite.ts';
import { dirToFace, dirToLatLon, faceToDir, GUTTER_PX, INNER_PX, latLonToDir, pixelMetres, TILE_PX, tileBounds } from './cube.ts';
import { encodeTile, sample, SHORE_ALPHA, SHORE_MIN, SHORE_STEPS, srgbLut, srgbToLinear, toneAndPyramid, TONE, type ColourFit, type Pyramid } from './finish.ts';
import { searchScenes, type Scene } from './stac.ts';
import { epsgOf, toUtm, type Zone } from './utm.ts';
import { buildWater, distanceTo, sdfAt, type WaterGrid } from './water.ts';
import {
  BASE_MAX_LEVEL,
  fineTiles,
  FINE_MAX_LEVEL,
  FINE_PICK_LEVEL,
  insideTile,
  NORTH_LIMIT,
  s2Zone,
  seasonFor,
  SHARD_LEVEL,
  SOUTH_LIMIT,
  tileBoxes,
  tilePoints,
  zoneEdgeKm,
  type ShardSpec,
} from './world-cells.ts';

/** The world's one dark-object offset (measured on the region proof): the same everywhere, so shards agree. */
export const WORLD_DARK: [number, number, number] = [0.0057, 0.0112, 0.0066];
const ZONE_BLEND_KM = 3;
const C8K_W = 8192;
const C8K_H = 4096;

export interface ShardOptions {
  work: string;
  perOrbit: number;
  quality: number;
  /** Dry runs: at most this many level-8 blocks of the 10 m tier (default: all). */
  maxFineBlocks?: number;
  /** The free plan's T1: the base from the 80 m overviews (levels 6–8), the fewest dates, no 10 m tier. */
  t1?: boolean;
  log: (s: string) => void;
}

interface Source {
  zone: Zone;
  grid: Grid;
  plan: Plan;
  comp: Composite;
  pyr: Pyramid;
  water: WaterGrid;
  /** How far inside its own pictures a point is, as a 0–1 ramp over EDGE_RAMP_M, on its pyramid step of about 160 m. */
  ramp?: { m: number; w: number; h: number; data: Float32Array };
}

const EDGE_RAMP_M = 4000;
/** A zone's grid reaches this far past its zone edge (MGRS tiles overhang zone edges, by up to about 100 km far north). */
const ZONE_REACH_KM = 60;
/** A source outside its own zone still weighs this much (so pictures hand over smoothly where one zone's tiles end). */
const FOREIGN_WEIGHT = 0.02;

function withRamp(src: Source): Source {
  const R = resOf(src.grid);
  const m = Math.max(0, Math.min(src.pyr.length - 1, Math.round(Math.log2(160 / R))));
  const p = src.pyr[m];
  const d = distanceTo(p.w, p.h, (i) => !p.q[i]);
  const cell = R * 2 ** m;
  const data = new Float32Array(p.w * p.h);
  for (let i = 0; i < data.length; i++) {
    const t = Math.min(1, Math.max(0, (d[i] * cell - cell / 2) / EDGE_RAMP_M));
    data[i] = t * t * (3 - 2 * t);
  }
  return { ...src, ramp: { m, w: p.w, h: p.h, data } };
}

const zoneKey = (z: Zone) => `${z.zone}${z.south ? 'S' : 'N'}`;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 12);
const usable = (lat: number) => lat >= SOUTH_LIMIT && lat <= NORTH_LIMIT;

/** A grid in one zone over the points of some boxes that `inside` accepts, with a margin, its top on COG tile rows. */
function gridOver(boxes: number[][], zone: Zone, res: number, inside: (lat: number, lon: number) => boolean, alignN0: number, marginM: number): Grid | null {
  let eMin = Infinity;
  let eMax = -Infinity;
  let nMin = Infinity;
  let nMax = -Infinity;
  const K = 120;
  for (const [w, s, e, n] of boxes)
    for (let j = 0; j <= K; j++)
      for (let i = 0; i <= K; i++) {
        const lat = s + ((n - s) * j) / K;
        const lon = w + ((e - w) * i) / K;
        if (!inside(lat, lon)) continue;
        const p = toUtm(lat, lon, zone);
        eMin = Math.min(eMin, p.e);
        eMax = Math.max(eMax, p.e);
        nMin = Math.min(nMin, p.n);
        nMax = Math.max(nMax, p.n);
      }
  if (!Number.isFinite(eMin)) return null;
  const e0 = Math.floor((eMin - marginM) / res) * res;
  const e1 = Math.ceil((eMax + marginM) / res) * res;
  const top = Math.ceil((nMax + marginM) / res) * res;
  const bottom = Math.floor((nMin - marginM) / res) * res;
  const block = (res === 10 ? 1024 : 512) * res;
  const n0 = alignN0 - Math.floor((alignN0 - top) / block) * block;
  return { zone, e0, n0, w: (e1 - e0) / res, h: Math.ceil((n0 - bottom) / res), res };
}

/** The same plan (dates, gains, orbit weights) on another grid of the same zone: the 10 m tier keeps the base's dates. */
function replan(plan: Plan, grid: Grid): Plan {
  const cpx = 160;
  const cw = Math.ceil((grid.w * resOf(grid)) / cpx);
  const ch = Math.ceil((grid.h * resOf(grid)) / cpx);
  const base = plan.grid;
  const weights: Record<number, Float32Array> = {};
  for (const o of plan.orbits) {
    const src = plan.weights[o];
    const w = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) {
        const e = grid.e0 + (x + 0.5) * cpx;
        const n = grid.n0 - (y + 0.5) * cpx;
        const bx = Math.max(0, Math.min(plan.cw - 1, Math.floor((e - base.e0) / cpx)));
        const by = Math.max(0, Math.min(plan.ch - 1, Math.floor((base.n0 - n) / cpx)));
        w[y * cw + x] = src[by * plan.cw + bx];
      }
    weights[o] = w;
  }
  return { ...plan, grid, cw, ch, weights };
}

const WORLD_FIT: ColourFit = { dark: WORLD_DARK, field: { col0: 0, row0: 0, cols: 1, rows: 1, data: new Float32Array([1, 1, 1]) } };

/**
 * Renders one tile from several zone sources: per pixel, each source with a picture there weighs by how far inside its
 * zone the pixel is (a 6 km ramp across zone edges). Alpha as the contract's version 2: 0 for no picture, else the shore.
 */
function renderMulti(sources: Source[], face: number, level: number, x: number, y: number, levelM: number) {
  const { s, a0, b1 } = tileBounds(level, x, y);
  const STEP = 16;
  const K = TILE_PX / STEP + 1;
  const clat = new Float64Array(K * K);
  const clon = new Float64Array(K * K);
  const cE = sources.map(() => new Float64Array(K * K));
  const cN = sources.map(() => new Float64Array(K * K));
  for (let j = 0; j < K; j++)
    for (let i = 0; i < K; i++) {
      const a = a0 + ((i * STEP - GUTTER_PX) * s) / INNER_PX;
      const b = b1 - ((j * STEP - GUTTER_PX) * s) / INNER_PX;
      const ll = dirToLatLon(faceToDir(face, a, b));
      const k = j * K + i;
      clat[k] = ll.lat;
      clon[k] = ll.lon;
      sources.forEach((src, q) => {
        const u = toUtm(ll.lat, ll.lon, src.zone);
        cE[q][k] = u.e;
        cN[q][k] = u.n;
      });
    }
  const tileM = pixelMetres(level, a0 + s / 2, b1 - s / 2);
  const mips = sources.map((src) => {
    const mf = Math.max(0, Math.log2(tileM / resOf(src.grid)));
    return { m0: Math.floor(mf), mt: mf - Math.floor(mf), bicubic: tileM / resOf(src.grid) < 1.25 };
  });
  const lut = srgbLut();
  const rgba = new Uint8Array(TILE_PX * TILE_PX * 4);
  const c0 = [0, 0, 0];
  const c1 = [0, 0, 0];
  const acc = [0, 0, 0];
  let any = false;
  let wet = false;
  for (let j = 0; j < TILE_PX; j++) {
    const gy = (j + 0.5) / STEP;
    const ky = Math.min(K - 2, Math.floor(gy));
    const ty = gy - ky;
    for (let i = 0; i < TILE_PX; i++) {
      const gx = (i + 0.5) / STEP;
      const kx = Math.min(K - 2, Math.floor(gx));
      const tx = gx - kx;
      const k = ky * K + kx;
      const lerp = (arr: Float64Array) => (arr[k] * (1 - tx) + arr[k + 1] * tx) * (1 - ty) + (arr[k + K] * (1 - tx) + arr[k + K + 1] * tx) * ty;
      const lat = lerp(clat);
      const lon = lerp(clon);
      acc[0] = acc[1] = acc[2] = 0;
      let wsum = 0;
      let sdf = 0;
      for (let q = 0; q < sources.length; q++) {
        const src = sources[q];
        const R = resOf(src.grid);
        const fx = (lerp(cE[q]) - src.grid.e0) / R;
        const fy = (src.grid.n0 - lerp(cN[q])) / R;
        const { m0, mt, bicubic } = mips[q];
        const pm = src.pyr[Math.min(m0, src.pyr.length - 1)];
        const sc = 2 ** Math.min(m0, src.pyr.length - 1);
        const qx = Math.floor(fx / sc);
        const qy = Math.floor(fy / sc);
        if (qx < 0 || qy < 0 || qx >= pm.w || qy >= pm.h || !pm.q[qy * pm.w + qx]) continue;
        if (!sample(src.pyr, m0, fx, fy, bicubic && m0 === 0, c0)) continue;
        if (mt > 0.001 && sample(src.pyr, m0 + 1, fx, fy, false, c1)) for (let b = 0; b < 3; b++) c0[b] = c0[b] * (1 - mt) + c1[b] * mt;
        const d = sdfAt(src.water, lerp(cE[q]), lerp(cN[q]));
        // Own zone first (a 6 km ramp across the zone line), and each picture fading in from its own edge, so where one
        // zone's tiles end the other's take over smoothly.
        let zw = sources.length === 1 ? 1 : Math.max(FOREIGN_WEIGHT, Math.min(1, Math.max(0, (zoneEdgeKm(src.zone, lat, lon) + ZONE_BLEND_KM) / (2 * ZONE_BLEND_KM))));
        if (src.ramp && sources.length > 1) {
          const rs = 2 ** src.ramp.m;
          const rx = Math.min(src.ramp.w - 1, Math.max(0, Math.floor(fx / rs)));
          const ry = Math.min(src.ramp.h - 1, Math.max(0, Math.floor(fy / rs)));
          zw *= Math.max(1e-4, src.ramp.data[ry * src.ramp.w + rx]);
        }
        acc[0] += c0[0] * zw;
        acc[1] += c0[1] * zw;
        acc[2] += c0[2] * zw;
        sdf += (Number.isNaN(d) ? 1e5 : d) * zw;
        wsum += zw;
      }
      const o = (j * TILE_PX + i) * 4;
      if (wsum > 0 && usable(lat)) {
        rgba[o] = lut[Math.round(acc[0] / wsum)];
        rgba[o + 1] = lut[Math.round(acc[1] / wsum)];
        rgba[o + 2] = lut[Math.round(acc[2] / wsum)];
        const a = Math.max(SHORE_MIN, Math.min(255, Math.round(SHORE_ALPHA + (SHORE_STEPS * (sdf / wsum)) / levelM)));
        rgba[o + 3] = a;
        if (a < SHORE_ALPHA) wet = true;
        if (i >= GUTTER_PX && j >= GUTTER_PX && i < TILE_PX - GUTTER_PX && j < TILE_PX - GUTTER_PX) any = true;
      }
    }
  }
  return { rgba, any, wet };
}

/** The match field to color-8k over a cell, from the cell's own level-6 tile (linear means per color-8k pixel). */
async function matchFromTile(face: number, x: number, y: number, rgba: Uint8Array) {
  return matchFromTiles(face, SHARD_LEVEL, [{ x, y, rgba }]);
}

/** The match field to color-8k from some tiles of one level (linear means per color-8k pixel). */
async function matchFromTiles(face: number, level: number, tiles: { x: number; y: number; rgba: Uint8Array }[]) {
  const c8k = await sharp(join(new URL('../..', import.meta.url).pathname, 'public/earth/color-8k.avif')).removeAlpha().raw().toBuffer();
  const sums = new Map<number, number[]>();
  // (Every other pixel is plenty for 4.9 km cells.)
  const step = level > SHARD_LEVEL ? 2 : 1;
  for (const { x, y, rgba } of tiles) {
    const { s, a0, b1 } = tileBounds(level, x, y);
    for (let j = GUTTER_PX; j < TILE_PX - GUTTER_PX; j += step)
      for (let i = GUTTER_PX; i < TILE_PX - GUTTER_PX; i += step) {
        const o = (j * TILE_PX + i) * 4;
        if (!rgba[o + 3]) continue;
        const ll = dirToLatLon(faceToDir(face, a0 + ((i + 0.5 - GUTTER_PX) * s) / INNER_PX, b1 - ((j + 0.5 - GUTTER_PX) * s) / INNER_PX));
        const col = Math.floor(((ll.lon + 180) / 360) * C8K_W) % C8K_W;
        const row = Math.min(C8K_H - 1, Math.floor(((90 - ll.lat) / 180) * C8K_H));
        const key = row * C8K_W + col;
        const v = sums.get(key) ?? [0, 0, 0, 0];
        for (let b = 0; b < 3; b++) v[b] += srgbToLinear(rgba[o + b] / 255);
        v[3]++;
        sums.set(key, v);
      }
  }
  if (!sums.size) return null;
  const keys = [...sums.keys()];
  const cols = keys.map((k) => k % C8K_W);
  const rows = keys.map((k) => Math.floor(k / C8K_W));
  // (A cell across the antimeridian keeps its larger side.)
  const col0 = Math.min(...cols);
  const col1 = Math.max(...cols);
  if (col1 - col0 > C8K_W / 2) return null;
  const row0 = Math.min(...rows);
  const nc = col1 - col0 + 1;
  const nr = Math.max(...rows) - row0 + 1;
  const data = new Array(nc * nr * 3).fill(1);
  for (const [key, v] of sums) {
    if (v[3] < 8) continue;
    const col = key % C8K_W;
    const row = Math.floor(key / C8K_W);
    for (let b = 0; b < 3; b++) {
      const t = srgbToLinear(c8k[(row * C8K_W + col) * 3 + b] / 255);
      const p = v[b] / v[3];
      data[((row - row0) * nc + (col - col0)) * 3 + b] = Math.round(Math.min(8, Math.max(1 / 64, Math.max(1e-4, t) / Math.max(1e-4, p))) * 1000) / 1000;
    }
  }
  return { grid: 'color-8k', width: C8K_W, height: C8K_H, col0, row0, cols: nc, rows: nr, baked: 0, data };
}

export interface ShardStats {
  id: string;
  bytes: number;
  tiles: number;
  fineTiles: number;
  zones: string[];
  dates: string[];
  downloadMB: number;
  cpuSeconds: number;
  seconds: number;
}

/** Builds one shard's archive. */
export async function buildShard(spec: ShardSpec, opts: ShardOptions): Promise<{ archive: Uint8Array; stats: ShardStats }> {
  const t0 = Date.now();
  const cpu0 = process.cpuUsage();
  const net0 = netStats.bytes;
  const log = (m: string) => opts.log(`${spec.id}: ${m}`);
  const work = join(opts.work, spec.id);
  mkdirSync(work, { recursive: true });
  const { face, x, y } = spec;
  const insideCell = (lat: number, lon: number) => usable(lat) && insideTile(face, SHARD_LEVEL, x, y, lat, lon);
  const boxes = tileBoxes(face, SHARD_LEVEL, x, y, 0.06);
  // Which zones the cell's points fall in.
  const zones = new Map<string, Zone>();
  for (const p of tilePoints(face, SHARD_LEVEL, x, y, 48)) if (usable(p.lat)) zones.set(zoneKey(s2Zone(p.lat, p.lon)), s2Zone(p.lat, p.lon));
  const ranges = seasonFor(spec.lat);
  const baseRes = opts.t1 ? 80 : 40;
  const baseMax = opts.t1 ? 8 : BASE_MAX_LEVEL;
  const scenes = new Map<string, Scene>();
  for (const b of boxes) for (const sc of await searchScenes(work, b, ranges, 30)) scenes.set(sc.id, sc);
  log(`${scenes.size} scenes in ${ranges.map((r) => r.join('…')).join(', ')}; zones ${[...zones.keys()].join(', ')}`);
  // Keep the 15 clearest acquisitions per orbit, each whole (all its tiles: an acquisition missing a tile would leave a
  // hole), so fewer overviews are scored.
  const byTake = new Map<string, Scene[]>();
  for (const sc of scenes.values()) byTake.set(sc.datatake, [...(byTake.get(sc.datatake) ?? []), sc]);
  const byOrbit = new Map<number, { take: string; cloud: number }[]>();
  for (const [take, list] of byTake) byOrbit.set(list[0].orbit, [...(byOrbit.get(list[0].orbit) ?? []), { take, cloud: list.reduce((s, sc) => s + sc.cloud, 0) / list.length }]);
  const keepIds = new Set<string>();
  for (const list of byOrbit.values())
    for (const t of list.sort((p, q) => p.cloud - q.cloud || (p.take < q.take ? -1 : 1)).slice(0, opts.t1 ? 6 : 15)) for (const sc of byTake.get(t.take)!) keepIds.add(sc.id);
  const kept = [...scenes.values()].filter((sc) => keepIds.has(sc.id)).sort((p, q) => (p.id < q.id ? -1 : 1));

  // The base tier, zone by zone.
  const base: Source[] = [];
  const dates = new Set<string>();
  for (const [zk, zone] of [...zones.entries()].sort()) {
    const mine = kept.filter((sc) => sc.epsg === epsgOf(zone));
    if (!mine.length) {
      log(`zone ${zk}: no scenes`);
      continue;
    }
    // Takes whose datatake also covers other zones carry over (a datatake is one pass): their ids keep scenes apart.
    const inZone = (lat: number, lon: number) => insideCell(lat, lon) && zoneEdgeKm(zone, lat, lon) > -ZONE_REACH_KM;
    const grid = gridOver(boxes, zone, baseRes, inZone, mine[0].n0, 3000);
    if (!grid) continue;
    const plan = await planComposite(grid, mine, boxes[0], { perOrbit: opts.perOrbit, minOrbitShare: 0.03, blendKm: 12, log, inside: inZone, snowClear: spec.snow });
    if (!plan.takes.length) continue;
    const key = hash({ grid, takes: plan.takes.map((t) => t.datatake), v: 3 });
    const comp = await buildComposite(plan, work, key, log);
    const water = await buildWater(plan, comp, work, key, log);
    const pyr = toneAndPyramid(comp, WORLD_FIT, { highlights: true });
    for (const t of plan.takes) dates.add(t.date);
    base.push(withRamp({ zone, grid, plan, comp, pyr, water }));
    log(`zone ${zk}: base composite ${grid.w} × ${grid.h} at ${baseRes} m from ${plan.takes.length} dates`);
  }
  if (!base.length) throw new Error(`${spec.id}: no Sentinel-2 scenes`);

  const mid = dirToFace(latLonToDir(spec.lat, spec.lon));
  const levelM = (level: number) => Math.round(pixelMetres(level, mid.a, mid.b) * 100) / 100;
  const tiles: { face: number; level: number; x: number; y: number; flags: number; data: Uint8Array }[] = [];
  const levels: { level: number; tiles: number; bytes: number; pixelM: number }[] = [];
  const add = async (level: number, tx: number, ty: number, sources: Source[]) => {
    const r = renderMulti(sources, face, level, tx, ty, levelM(level));
    if (!r.any) return null;
    const data = await encodeTile(r.rgba, false, opts.quality);
    tiles.push({ face, level, x: tx, y: ty, flags: FLAG_ALPHA | (r.wet ? FLAG_WATER : 0), data });
    let L = levels.find((l) => l.level === level);
    if (!L) levels.push((L = { level, tiles: 0, bytes: 0, pixelM: levelM(level) }));
    L.tiles++;
    L.bytes += data.length;
    return r.rgba;
  };
  let cellRgba: Uint8Array | null = null;
  for (let level = SHARD_LEVEL; level <= baseMax; level++) {
    const per = 2 ** (level - SHARD_LEVEL);
    for (let j = 0; j < per; j++)
      for (let i = 0; i < per; i++) {
        const rgba = await add(level, x * per + i, y * per + j, base);
        if (level === SHARD_LEVEL) cellRgba = rgba;
      }
    log(`level ${level}: ${levels.find((l) => l.level === level)?.tiles ?? 0} tiles`);
  }

  // The 10 m tier, one level-8 block at a time (its composite is made, used and deleted).
  const picks = opts.t1 ? [] : fineTiles(spec);
  const blocks = new Map<string, { x: number; y: number }[]>();
  for (const t of picks) {
    const k = `${t.x >> 1},${t.y >> 1}`;
    blocks.set(k, [...(blocks.get(k) ?? []), t]);
  }
  let blockList = [...blocks.entries()].sort((p, q) => (p[0] < q[0] ? -1 : 1));
  if (opts.maxFineBlocks !== undefined) {
    // A dry run takes the blocks nearest its focus (or the cell's middle), the fullest first among equals.
    const [fLat, fLon] = spec.focus ?? [spec.lat, spec.lon];
    blockList = blockList
      .map(([k, v]) => {
        const [bx, by] = k.split(',').map(Number);
        const c = tilePoints(face, 8, bx, by, 1)[0];
        const km = Math.hypot((c.lat - fLat) * 111, (c.lon - fLon) * 111 * Math.cos((fLat * Math.PI) / 180));
        return { k, v, score: -km + v.length };
      })
      .sort((p, q) => q.score - p.score || (p.k < q.k ? -1 : 1))
      .slice(0, opts.maxFineBlocks)
      .map(({ k, v }) => [k, v] as [string, { x: number; y: number }[]]);
  }
  let fineCount = 0;
  for (const [k, picked] of blockList) {
    const [bx, by] = k.split(',').map(Number);
    const bdir = join(work, `block-${bx}-${by}`);
    mkdirSync(bdir, { recursive: true });
    const bBoxes = tileBoxes(face, 8, bx, by, 0.02);
    // Only the picked level-9 tiles of the block (a block with one pick reads a quarter of the data).
    const inBlock = (lat: number, lon: number) => usable(lat) && insideTile(face, 8, bx, by, lat, lon) && picked.some((t) => insideTile(face, FINE_PICK_LEVEL, t.x, t.y, lat, lon));
    const fine: Source[] = [];
    for (const src of base) {
      const inZone = (lat: number, lon: number) => inBlock(lat, lon) && zoneEdgeKm(src.zone, lat, lon) > -ZONE_REACH_KM;
      const grid = gridOver(bBoxes, src.zone, 10, inZone, src.plan.takes[0].scenes[0].n0, 800);
      if (!grid) continue;
      const plan = replan(src.plan, grid);
      const key = hash({ grid, takes: plan.takes.map((t) => t.datatake), v: 3 });
      const comp = await buildComposite(plan, bdir, key, log);
      const water = await buildWater(plan, comp, bdir, key, log);
      fine.push(withRamp({ zone: src.zone, grid, plan, comp, pyr: toneAndPyramid(comp, WORLD_FIT, { highlights: true }), water }));
    }
    for (const t of picked)
      for (let level = FINE_PICK_LEVEL + 1; level <= FINE_MAX_LEVEL; level++) {
        const per = 2 ** (level - FINE_PICK_LEVEL);
        for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) if (await add(level, t.x * per + i, t.y * per + j, fine)) fineCount++;
      }
    rmSync(bdir, { recursive: true, force: true });
    log(`10 m block ${k}: ${picked.length} level-9 tiles, ${fineCount} tiles so far`);
  }

  levels.sort((p, q) => p.level - q.level);
  const match = cellRgba ? await matchFromTile(face, x, y, cellRgba) : null;
  const meta = {
    version: VERSION,
    layout: 3,
    name: spec.id,
    cell: { face, x, y, level: SHARD_LEVEL },
    bbox: boxes[0],
    format: 'webp',
    mime: 'image/webp',
    tileSize: TILE_PX,
    gutter: GUTTER_PX,
    inner: INNER_PX,
    minLevel: SHARD_LEVEL,
    maxLevel: Math.max(...levels.map((l) => l.level)),
    colourSpace: 'srgb',
    alpha: 'straight',
    featherKm: 0,
    shore: { alpha: SHORE_ALPHA, stepsPerPixel: SHORE_STEPS, min: SHORE_MIN, max: 255, none: 0, landPositive: true },
    levels,
    tiers: opts.t1
      ? { base: { levels: [SHARD_LEVEL, baseMax], metres: baseRes }, fine: { levels: [], metres: 10, picked: '0'.repeat(16), built: 'none (T1)' } }
      : { base: { levels: [SHARD_LEVEL, baseMax], metres: baseRes }, fine: { levels: [FINE_PICK_LEVEL + 1, FINE_MAX_LEVEL], metres: 10, picked: spec.fine, built: blockList.length === blocks.size ? 'all' : `${blockList.length} of ${blocks.size} blocks` } },
    source: 'Contains modified Copernicus Sentinel data (Sentinel-2 L2A, collection 1), read from Earth Search on AWS',
    zones: base.map((b) => zoneKey(b.zone)),
    dates: [...dates].sort(),
    colour: { dark: WORLD_DARK, gain: TONE.gain, power: TONE.power, saturation: TONE.sat, bakedMatch: 0 },
    match,
    tool: 'tools/imagery/world.ts',
  };
  const archive = writeArchive(meta, tiles);
  rmSync(work, { recursive: true, force: true });
  const cpu = process.cpuUsage(cpu0);
  const stats: ShardStats = {
    id: spec.id,
    bytes: archive.length,
    tiles: tiles.length,
    fineTiles: fineCount,
    zones: meta.zones,
    dates: meta.dates,
    downloadMB: Math.round((netStats.bytes - net0) / 1e5) / 10,
    cpuSeconds: Math.round((cpu.user + cpu.system) / 1e6),
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  log(`done: ${(archive.length / 1e6).toFixed(1)} MB, ${tiles.length} tiles (${fineCount} at 10 m), ${stats.downloadMB} MB read, ${stats.seconds} s`);
  return { archive, stats };
}


/** A T2 block: the 10 m tier over some level-9 tiles of one level-8 block (docs/imagery-tiles.md, "The free tiers"). */
export interface BlockJob {
  id: string;
  face: number;
  x: number;
  y: number;
  /** The picked level-9 tiles inside the block. */
  tiles: { x: number; y: number }[];
  lat: number;
  lon: number;
}

/**
 * Builds one T2 block's archive: its own dates (the clearest, least hazy of the season for its latitude), one 10 m composite
 * per UTM zone over its picked level-9 tiles only, water at 20 m, levels 10 and 11, and its colour match to color-8k.
 */
export async function buildBlock(job: BlockJob, opts: ShardOptions): Promise<{ archive: Uint8Array; stats: ShardStats }> {
  const t0 = Date.now();
  const cpu0 = process.cpuUsage();
  const net0 = netStats.bytes;
  const log = (m: string) => opts.log(`${job.id}: ${m}`);
  const work = join(opts.work, job.id);
  mkdirSync(work, { recursive: true });
  const { face, x, y } = job;
  const inside = (lat: number, lon: number) => usable(lat) && insideTile(face, 8, x, y, lat, lon) && job.tiles.some((t) => insideTile(face, FINE_PICK_LEVEL, t.x, t.y, lat, lon));
  const boxes = tileBoxes(face, 8, x, y, 0.02);
  const zones = new Map<string, Zone>();
  for (const t of job.tiles) for (const p of tilePoints(face, FINE_PICK_LEVEL, t.x, t.y, 12)) if (usable(p.lat)) zones.set(zoneKey(s2Zone(p.lat, p.lon)), s2Zone(p.lat, p.lon));
  const ranges = seasonFor(job.lat);
  const scenes = new Map<string, Scene>();
  for (const b of boxes) for (const sc of await searchScenes(work, b, ranges, 30)) scenes.set(sc.id, sc);
  // The 10 clearest acquisitions an orbit, each whole.
  const byTake = new Map<string, Scene[]>();
  for (const sc of scenes.values()) byTake.set(sc.datatake, [...(byTake.get(sc.datatake) ?? []), sc]);
  const byOrbit = new Map<number, { take: string; cloud: number }[]>();
  for (const [take, list] of byTake) byOrbit.set(list[0].orbit, [...(byOrbit.get(list[0].orbit) ?? []), { take, cloud: list.reduce((a, sc) => a + sc.cloud, 0) / list.length }]);
  const keep = new Set<string>();
  for (const list of byOrbit.values()) for (const t of list.sort((p, q) => p.cloud - q.cloud || (p.take < q.take ? -1 : 1)).slice(0, 10)) for (const sc of byTake.get(t.take)!) keep.add(sc.id);
  const kept = [...scenes.values()].filter((sc) => keep.has(sc.id)).sort((p, q) => (p.id < q.id ? -1 : 1));
  log(`${scenes.size} scenes, ${kept.length} kept; zones ${[...zones.keys()].join(', ')}`);
  const sources: Source[] = [];
  const dates = new Set<string>();
  for (const [zk, zone] of [...zones.entries()].sort()) {
    const mine = kept.filter((sc) => sc.epsg === epsgOf(zone));
    if (!mine.length) continue;
    const inZone = (lat: number, lon: number) => inside(lat, lon) && zoneEdgeKm(zone, lat, lon) > -ZONE_REACH_KM;
    const grid = gridOver(boxes, zone, 10, inZone, mine[0].n0, 800);
    if (!grid) continue;
    const plan = await planComposite(grid, mine, boxes[0], { perOrbit: opts.perOrbit, minOrbitShare: 0.03, blendKm: 12, log, inside: inZone, snowClear: false });
    if (!plan.takes.length) continue;
    const key = hash({ grid, takes: plan.takes.map((t) => t.datatake), v: 'T2' });
    const comp = await buildComposite(plan, work, key, log);
    const water = await buildWater(plan, comp, work, key, log);
    for (const t of plan.takes) dates.add(t.date);
    sources.push(withRamp({ zone, grid, plan, comp, pyr: toneAndPyramid(comp, WORLD_FIT, { highlights: true }), water }));
    log(`zone ${zk}: 10 m composite ${grid.w} × ${grid.h} from ${plan.takes.length} dates`);
  }
  if (!sources.length) throw new Error(`${job.id}: no Sentinel-2 scenes`);
  const mid = dirToFace(latLonToDir(job.lat, job.lon));
  const levelM = (level: number) => Math.round(pixelMetres(level, mid.a, mid.b) * 100) / 100;
  const tiles: { face: number; level: number; x: number; y: number; flags: number; data: Uint8Array }[] = [];
  const levels: { level: number; tiles: number; bytes: number; pixelM: number }[] = [];
  const forMatch: { x: number; y: number; rgba: Uint8Array }[] = [];
  for (let level = FINE_PICK_LEVEL + 1; level <= FINE_MAX_LEVEL; level++) {
    const per = 2 ** (level - FINE_PICK_LEVEL);
    for (const t of job.tiles)
      for (let j = 0; j < per; j++)
        for (let i = 0; i < per; i++) {
          const tx = t.x * per + i;
          const ty = t.y * per + j;
          const r = renderMulti(sources, face, level, tx, ty, levelM(level));
          if (!r.any) continue;
          const data = await encodeTile(r.rgba, false, opts.quality);
          tiles.push({ face, level, x: tx, y: ty, flags: FLAG_ALPHA | (r.wet ? FLAG_WATER : 0), data });
          if (level === FINE_PICK_LEVEL + 1) forMatch.push({ x: tx, y: ty, rgba: r.rgba });
          let L = levels.find((l) => l.level === level);
          if (!L) levels.push((L = { level, tiles: 0, bytes: 0, pixelM: levelM(level) }));
          L.tiles++;
          L.bytes += data.length;
        }
    log(`level ${level}: ${levels.find((l) => l.level === level)?.tiles ?? 0} tiles`);
  }
  const match = await matchFromTiles(face, FINE_PICK_LEVEL + 1, forMatch);
  const meta = {
    version: VERSION,
    layout: 3,
    tier: 'T2',
    name: job.id,
    cell: { face, x, y, level: 8 },
    picked: job.tiles.map((t) => [t.x, t.y]),
    bbox: boxes[0],
    format: 'webp',
    mime: 'image/webp',
    tileSize: TILE_PX,
    gutter: GUTTER_PX,
    inner: INNER_PX,
    minLevel: FINE_PICK_LEVEL + 1,
    maxLevel: FINE_MAX_LEVEL,
    colourSpace: 'srgb',
    alpha: 'straight',
    featherKm: 0,
    shore: { alpha: SHORE_ALPHA, stepsPerPixel: SHORE_STEPS, min: SHORE_MIN, max: 255, none: 0, landPositive: true },
    levels,
    source: 'Contains modified Copernicus Sentinel data (Sentinel-2 L2A, collection 1), read from Earth Search on AWS',
    zones: sources.map((b) => zoneKey(b.zone)),
    dates: [...dates].sort(),
    colour: { dark: WORLD_DARK, gain: TONE.gain, power: TONE.power, saturation: TONE.sat, bakedMatch: 0 },
    match,
    tool: 'tools/imagery/world.ts --tier t2',
  };
  const archive = writeArchive(meta, tiles);
  rmSync(work, { recursive: true, force: true });
  const cpu = process.cpuUsage(cpu0);
  const stats: ShardStats = {
    id: job.id,
    bytes: archive.length,
    tiles: tiles.length,
    fineTiles: tiles.length,
    zones: meta.zones,
    dates: meta.dates,
    downloadMB: Math.round((netStats.bytes - net0) / 1e5) / 10,
    cpuSeconds: Math.round((cpu.user + cpu.system) / 1e6),
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  log(`done: ${(archive.length / 1e6).toFixed(2)} MB, ${tiles.length} tiles, ${stats.downloadMB} MB read, ${stats.seconds} s`);
  return { archive, stats };
}
