// The cloud-free composite: Sentinel-2 L2A red, green and blue at 10 m on the scenes' own UTM grid (every tile of one
// UTM zone shares the same 10 m grid, so nothing is resampled here).
//
// 1. A quick pass over every candidate acquisition reads the 160 m overviews only (the scene classification and the
//    three bands) to score it: how much of the box it sees clear, and how hazy (blue over clear vegetation).
// 2. For each orbit, the clearest and least hazy acquisitions are kept. Each orbit gets its own per-pixel median, so
//    the set of dates never changes at a scene edge inside an orbit. Neighbouring orbits are matched by one gain per
//    band (measured where they overlap) and blended with weights that ramp across the overlap: no seam at the swath edge.
// 3. The full-resolution pass reads 1024-row strips, masks clouds, cloud shadows and cirrus (scene classification,
//    grown by 60 m), blends the overlapping MGRS tiles of each pass (Sen2Cor corrects every tile on its own, so a hard
//    switch would leave a step), and takes the per-band median of the clear dates. A pixel no date sees clear falls back to the
//    median of every date (bright beaches and roofs the classifier calls cloud), and is marked so.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { cachedCog, readWindow, type Cog } from './cog.ts';
import type { Scene } from './stac.ts';
import { fromUtm, toUtm, type Zone } from './utm.ts';

export interface Grid {
  zone: Zone;
  /** Top-left corner (metres) and size in pixels of `res` metres (10 when absent: the bands' own pixel). */
  e0: number;
  n0: number;
  w: number;
  h: number;
  /** Metres a pixel: 10 (the bands themselves) or 40 (their 4× overviews: the world's base tier). */
  res?: number;
}

/** A grid's pixel size in metres. */
export const resOf = (g: Grid) => g.res ?? 10;

export const STRIP = 1024;
const COARSE = 16; // 160 m
const CLEAR = new Set([2, 4, 5, 6, 7, 11]); // cast shadow, vegetation, bare, water, unclassified, snow
// Away from ice, snow is a passing cover like cloud: it only fills in where nothing else is seen.
const CLEAR_NO_SNOW = new Set([2, 4, 5, 6, 7]);
const CLOUDY = new Set([3, 8, 9, 10]); // cloud shadow, cloud medium and high probability, thin cirrus
const TILE_RAMP_M = 4500; // half the overlap of neighbouring MGRS tiles

export interface Take {
  datatake: string;
  orbit: number;
  date: string;
  scenes: Scene[];
  covered: number;
  clear: number;
  haze: number;
}

export interface Plan {
  grid: Grid;
  takes: Take[]; // the chosen ones
  orbits: number[]; // reference first
  gains: Record<number, [number, number, number]>;
  /** Per orbit, its blend weight on the 160 m grid (cw × ch). */
  weights: Record<number, Float32Array>;
  cw: number;
  ch: number;
  snowClear?: boolean;
}

/**
 * The grid covering a latitude and longitude box plus a margin, with its top aligned to a scene's COG tile rows (1024
 * rows at 10 m, 512 rows of an overview). `inside` (optional) limits the box to the points it accepts (a cell, a zone).
 */
export function makeGrid(bbox: number[], zone: Zone, marginM: number, alignN0: number, res = 10, inside?: (lat: number, lon: number) => boolean): Grid {
  let eMin = Infinity;
  let eMax = -Infinity;
  let nMin = Infinity;
  let nMax = -Infinity;
  const [w, s, e, n] = bbox;
  const K = inside ? 96 : 64;
  for (let k = 0; k <= K; k++) {
    const t = k / K;
    const pts = inside
      ? Array.from({ length: K + 1 }, (_, j) => [s + ((n - s) * j) / K, w + (e - w) * t]).filter(([la, lo]) => inside(la, lo))
      : [
          [s, w + (e - w) * t],
          [n, w + (e - w) * t],
          [s + (n - s) * t, w],
          [s + (n - s) * t, e],
        ];
    for (const [lat, lon] of pts) {
      const p = toUtm(lat, lon, zone);
      eMin = Math.min(eMin, p.e);
      eMax = Math.max(eMax, p.e);
      nMin = Math.min(nMin, p.n);
      nMax = Math.max(nMax, p.n);
    }
  }
  if (!Number.isFinite(eMin)) throw new Error('makeGrid: no point of the box inside');
  const e0 = Math.floor((eMin - marginM) / res) * res;
  const e1 = Math.ceil((eMax + marginM) / res) * res;
  const top = Math.ceil((nMax + marginM) / res) * res;
  const bottom = Math.floor((nMin - marginM) / res) * res;
  // Move the top up to a whole number of COG tile rows from the reference scene's top, so strips line up with them.
  const block = (res === 10 ? 1024 : 512) * res;
  const n0 = alignN0 - Math.floor((alignN0 - top) / block) * block;
  return { zone, e0, n0, w: (e1 - e0) / res, h: Math.ceil((n0 - bottom) / res), res };
}

const cog = cachedCog;

/** The overview level of a COG whose pixel is `factor` times the full-resolution one. */
function overview(c: Cog, factor: number): number {
  const k = c.ifds.findIndex((d) => Math.round(c.ifds[0].width / d.width) === factor);
  if (k < 0) throw new Error(`${c.url}: no ${factor}× overview`);
  return k;
}

/** Reads a scene band onto a grid window by nearest neighbour: grid pixel size `px` metres, scene pixel size `sp`. */
async function readOnto(
  url: string,
  scene: Scene,
  sp: number,
  factor: number,
  gx0: number,
  gy0: number,
  gw: number,
  gh: number,
  px: number,
  grid: Grid,
): Promise<{ data: Uint16Array | Uint8Array; map: Int32Array } | null> {
  const c = await cog(url);
  const level = factor === 1 ? 0 : overview(c, factor);
  const cell = sp * factor;
  // Scene-pixel window covering the grid window.
  const eA = grid.e0 + gx0 * px;
  const eB = grid.e0 + (gx0 + gw) * px;
  const nA = grid.n0 - gy0 * px;
  const nB = grid.n0 - (gy0 + gh) * px;
  const sx0 = Math.floor((eA - scene.e0) / cell) - 1;
  const sx1 = Math.ceil((eB - scene.e0) / cell) + 1;
  const sy0 = Math.floor((scene.n0 - nA) / cell) - 1;
  const sy1 = Math.ceil((scene.n0 - nB) / cell) + 1;
  const ifd = c.ifds[level];
  if (sx1 < 0 || sy1 < 0 || sx0 >= ifd.width || sy0 >= ifd.height) return null;
  const sw = sx1 - sx0;
  const sh = sy1 - sy0;
  const data = await readWindow(c, level, sx0, sy0, sw, sh);
  // Index into `data` for every grid pixel (or -1).
  const map = new Int32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    const nC = grid.n0 - (gy0 + y + 0.5) * px;
    const sy = Math.floor((scene.n0 - nC) / cell) - sy0;
    for (let x = 0; x < gw; x++) {
      const eC = grid.e0 + (gx0 + x + 0.5) * px;
      const sx = Math.floor((eC - scene.e0) / cell) - sx0;
      map[y * gw + x] = sx >= 0 && sx < sw && sy >= 0 && sy < sh ? sy * sw + sx : -1;
    }
  }
  return { data, map };
}

function median(v: number[] | Float64Array, n: number): number {
  if (n > 32) {
    const a = Float64Array.from(v.slice(0, n)).sort();
    return n % 2 ? a[(n - 1) >> 1] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
  }
  // Insertion sort: n is small (the dates of one orbit).
  for (let i = 1; i < n; i++) {
    const x = v[i];
    let j = i - 1;
    while (j >= 0 && v[j] > x) {
      v[j + 1] = v[j];
      j--;
    }
    v[j + 1] = x;
  }
  return n % 2 ? v[(n - 1) >> 1] : 0.5 * (v[n / 2 - 1] + v[n / 2]);
}

/** Acquisitions scored at once: enough to keep the network busy, few enough that their coarse rasters stay small. */
const SCORE_PARALLEL = 6;

/** Runs `fn` over the items, at most `n` at a time. */
async function inTurn<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

/** Squared-free chamfer distance (in pixels) from every pixel to the nearest zero of `mask`; the border counts as set. */
function distance(mask: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h);
  const INF = 1e9;
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? INF : 0;
  const a = 1;
  const b = Math.SQRT2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let m = d[i];
      if (x > 0) m = Math.min(m, d[i - 1] + a);
      if (y > 0) {
        m = Math.min(m, d[i - w] + a);
        if (x > 0) m = Math.min(m, d[i - w - 1] + b);
        if (x < w - 1) m = Math.min(m, d[i - w + 1] + b);
      }
      d[i] = m;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let m = d[i];
      if (x < w - 1) m = Math.min(m, d[i + 1] + a);
      if (y < h - 1) {
        m = Math.min(m, d[i + w] + a);
        if (x < w - 1) m = Math.min(m, d[i + w + 1] + b);
        if (x > 0) m = Math.min(m, d[i + w - 1] + b);
      }
      d[i] = m;
    }
  return d;
}

const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

export interface PlanOptions {
  perOrbit: number;
  /** Orbits that see less than this share of the box are left out. */
  minOrbitShare: number;
  blendKm: number;
  log: (s: string) => void;
  /** Which points count as inside the area (default: the bbox). */
  inside?: (lat: number, lon: number) => boolean;
  /** Count snow as clear (ice sheets, high mountains in summer). */
  snowClear?: boolean;
}

/** Scores every acquisition on the 160 m overviews, picks the best per orbit, and works out gains and blend weights. */
export async function planComposite(grid: Grid, scenes: Scene[], bbox: number[], opts: PlanOptions): Promise<Plan> {
  const cpx = 10 * COARSE;
  const cw = Math.ceil((grid.w * resOf(grid)) / cpx);
  const ch = Math.ceil((grid.h * resOf(grid)) / cpx);
  const clear = opts.snowClear ? CLEAR : CLEAR_NO_SNOW;
  // Which coarse pixels are inside the latitude and longitude box (scores count only those).
  const inBox = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const p = fromUtm(grid.e0 + (x + 0.5) * cpx, grid.n0 - (y + 0.5) * cpx, grid.zone);
      inBox[y * cw + x] = (opts.inside ? opts.inside(p.lat, p.lon) : p.lon >= bbox[0] && p.lon <= bbox[2] && p.lat >= bbox[1] && p.lat <= bbox[3]) ? 1 : 0;
    }
  const boxCount = Math.max(1, inBox.reduce((s, v) => s + v, 0));

  // Group the scenes into acquisitions.
  const byTake = new Map<string, Scene[]>();
  for (const s of scenes) byTake.set(s.datatake, [...(byTake.get(s.datatake) ?? []), s]);

  interface Coarse {
    take: Take;
    scl: Uint8Array;
  }
  // One acquisition on the coarse grid: per pixel the classification and reflectance of the first of its tiles that sees
  // it. Only the classification is kept for every acquisition; the colour is read again for the chosen ones, orbit by
  // orbit (near the poles a box has 150 to 200 candidate acquisitions, and holding all their colour at once took gigabytes).
  const readTake = async (group: Scene[]) => {
    const scl = new Uint8Array(cw * ch);
    const rgb = [new Float32Array(cw * ch), new Float32Array(cw * ch), new Float32Array(cw * ch)];
    for (const s of group) {
      const [a, r, g, b] = await Promise.all([
        readOnto(s.href.scl, s, 20, 8, 0, 0, cw, ch, cpx, grid),
        readOnto(s.href.red, s, 10, 16, 0, 0, cw, ch, cpx, grid),
        readOnto(s.href.green, s, 10, 16, 0, 0, cw, ch, cpx, grid),
        readOnto(s.href.blue, s, 10, 16, 0, 0, cw, ch, cpx, grid),
      ]);
      if (!a || !r || !g || !b) continue;
      for (let i = 0; i < cw * ch; i++) {
        if (scl[i]) continue;
        const k = a.map[i];
        const kr = r.map[i];
        if (k < 0 || kr < 0 || !a.data[k] || !r.data[kr]) continue;
        scl[i] = a.data[k];
        rgb[0][i] = r.data[kr] * s.scale + s.offset;
        rgb[1][i] = g.data[g.map[i]] * s.scale + s.offset;
        rgb[2][i] = b.data[b.map[i]] * s.scale + s.offset;
      }
    }
    return { scl, rgb };
  };
  const coarse: Coarse[] = [];
  const keys = [...byTake.keys()].sort();
  let done = 0;
  await inTurn(keys, SCORE_PARALLEL, async (key) => {
    const group = byTake.get(key)!;
    const { scl, rgb } = await readTake(group);
    let covered = 0;
    let clearN = 0;
    const blues: number[] = [];
    for (let i = 0; i < cw * ch; i++) {
      if (!inBox[i] || !scl[i]) continue;
      covered++;
      if (clear.has(scl[i])) clearN++;
      if (scl[i] === 4) blues.push(rgb[2][i]);
    }
    const s0 = group[0];
    const take: Take = {
      datatake: key,
      orbit: s0.orbit,
      date: s0.datetime.slice(0, 10),
      scenes: [...group].sort((p, q) => (p.id < q.id ? -1 : 1)),
      covered: covered / boxCount,
      clear: covered ? clearN / covered : 0,
      haze: blues.length ? median(Float64Array.from(blues), blues.length) : 1,
    };
    coarse.push({ take, scl });
    done++;
    if (done % 10 === 0) opts.log(`  scored ${done}/${keys.length} acquisitions`);
  });
  coarse.sort((p, q) => (p.take.datatake < q.take.datatake ? -1 : 1));

  // Choose per orbit.
  const orbitShare = new Map<number, number>();
  for (const c of coarse) orbitShare.set(c.take.orbit, Math.max(orbitShare.get(c.take.orbit) ?? 0, c.take.covered));
  const orbits = [...orbitShare.entries()]
    .filter(([, share]) => share >= opts.minOrbitShare)
    .sort((p, q) => q[1] - p[1] || p[0] - q[0])
    .map(([o]) => o);
  // A zone's strip at the edge of the cell can lie almost wholly outside the passes filed under that zone: nothing to
  // compose here (the neighbouring zone's composite reaches across).
  if (!orbits.length) {
    opts.log(`  no orbit sees ${Math.round(100 * opts.minOrbitShare)}% of the area: left to the neighbouring zone`);
    return { grid, takes: [], orbits: [], gains: {}, weights: {}, cw, ch, snowClear: !!opts.snowClear };
  }
  const chosen: Coarse[] = [];
  for (const o of orbits) {
    const share = orbitShare.get(o) ?? 0;
    const mine = coarse.filter((c) => c.take.orbit === o && c.take.covered > 0.2 * share);
    // Clear and seeing (nearly) all of what the orbit sees first, the least hazy of those first.
    const isGood = (c: Coarse) => c.take.clear >= 0.97 && c.take.covered >= 0.9 * share;
    const good = mine.filter(isGood).sort((p, q) => p.take.haze - q.take.haze || (p.take.datatake < q.take.datatake ? -1 : 1));
    const rest = mine
      .filter((c) => !isGood(c))
      .sort((p, q) => q.take.clear * q.take.covered - p.take.clear * p.take.covered || (p.take.datatake < q.take.datatake ? -1 : 1));
    chosen.push(...[...good, ...rest].slice(0, opts.perOrbit));
  }
  // Every part of the box some acquisition sees clear must be seen by a chosen one: add, one at a time, the acquisition
  // that sees the most of what is left (an orbit's edge, a tile its chosen dates lack).
  const seenBy = new Uint8Array(cw * ch);
  const mark = (c: Coarse) => {
    for (let i = 0; i < cw * ch; i++) if (inBox[i] && clear.has(c.scl[i])) seenBy[i] = 1;
  };
  chosen.forEach(mark);
  for (let round = 0; round < 8; round++) {
    let best: Coarse | null = null;
    let bestGain = 0;
    for (const c of coarse) {
      if (chosen.includes(c) || !orbits.includes(c.take.orbit)) continue;
      let gain = 0;
      for (let i = 0; i < cw * ch; i++) if (inBox[i] && !seenBy[i] && clear.has(c.scl[i])) gain++;
      if (gain > bestGain || (gain === bestGain && gain > 0 && best && c.take.datatake < best.take.datatake)) {
        best = c;
        bestGain = gain;
      }
    }
    if (!best || bestGain < 0.002 * boxCount) break;
    chosen.push(best);
    mark(best);
    opts.log(`  gap fill: ${best.take.date} (orbit R${String(best.take.orbit).padStart(3, '0')}) sees ${((100 * bestGain) / boxCount).toFixed(1)}% of the box no chosen date saw`);
  }

  coarse.length = 0; // only the chosen ones from here on

  // Per orbit (reference first): its coarse median, its coverage, and the gain that matches it to the orbits before it.
  // Gains are measured on land only (vegetation or bare ground on some chosen date): sea and glint differ from date to
  // date and would skew them. Too little land shared, or an implausible ratio, keeps the gain at 1. Then each orbit's
  // blend weight, which fades it in over blendKm from the edge of its swath.
  const n = cw * ch;
  const land = new Uint8Array(n);
  for (const c of chosen) for (let i = 0; i < n; i++) if (c.scl[i] === 4 || c.scl[i] === 5) land[i] = 1;
  const gains: Record<number, [number, number, number]> = {};
  const weights: Record<number, Float32Array> = {};
  const buf = new Float64Array(64);
  let acc: Float32Array[] = [];
  for (const o of orbits) {
    const mine = chosen.filter((c) => c.take.orbit === o);
    const rgbs: Float32Array[][] = new Array(mine.length);
    await inTurn(
      mine.map((_, k) => k),
      SCORE_PARALLEL,
      async (k) => {
        rgbs[k] = (await readTake(byTake.get(mine[k].take.datatake)!)).rgb; // the tiles in the order scored
      },
    );
    const med = [new Float32Array(n).fill(NaN), new Float32Array(n).fill(NaN), new Float32Array(n).fill(NaN)];
    const cov = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      for (const c of mine) if (c.scl[i]) cov[i] = 1;
      for (let band = 0; band < 3; band++) {
        let k = 0;
        for (let m = 0; m < mine.length; m++) if (clear.has(mine[m].scl[i])) buf[k++] = rgbs[m][band][i];
        if (k) med[band][i] = median(buf, k);
      }
    }
    if (o === orbits[0]) {
      acc = med;
      gains[o] = [1, 1, 1];
    } else {
      const g: [number, number, number] = [1, 1, 1];
      for (let band = 0; band < 3; band++) {
        const ratios: number[] = [];
        for (let i = 0; i < n; i++) {
          if (!land[i]) continue;
          const p = acc[band][i];
          const q = med[band][i];
          if (p > 0.005 && q > 0.005) ratios.push(p / q);
        }
        ratios.sort((x, y) => x - y);
        if (ratios.length > 200) g[band] = Math.min(1.4, Math.max(0.7, ratios[ratios.length >> 1]));
      }
      gains[o] = g;
      for (let band = 0; band < 3; band++)
        for (let i = 0; i < n; i++) if (Number.isNaN(acc[band][i]) && !Number.isNaN(med[band][i])) acc[band][i] = med[band][i] * g[band];
    }
    const d = distance(cov, cw, ch);
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = cov[i] ? 0.001 + smooth((d[i] * cpx) / 1000 / opts.blendKm) : 0;
    weights[o] = w;
  }

  for (const o of orbits) {
    const mine = chosen.filter((c) => c.take.orbit === o);
    opts.log(
      `  orbit R${String(o).padStart(3, '0')}: sees ${(100 * (orbitShare.get(o) ?? 0)).toFixed(0)}% of the box, gain ${gains[o].map((v) => v.toFixed(3)).join('/')}, dates ${mine
        .map((c) => `${c.take.date} (${(100 * c.take.clear).toFixed(1)}% clear, blue ${c.take.haze.toFixed(3)})`)
        .join(', ')}`,
    );
  }
  return { grid, takes: chosen.map((c) => c.take), orbits, gains, weights, cw, ch, snowClear: !!opts.snowClear };
}

export interface Composite {
  grid: Grid;
  /** Reflectance × 10000, per band, row-major w × h. */
  bands: [Uint16Array, Uint16Array, Uint16Array];
  /** 0: no picture, 1: only cloudy dates (median of every date), 2: clear. */
  quality: Uint8Array;
}

/** Builds (or loads from the cache) the full-resolution composite, strip by strip. */
export async function buildComposite(plan: Plan, cacheDir: string, key: string, log: (s: string) => void): Promise<Composite> {
  const { grid } = plan;
  const dir = join(cacheDir, `composite-${key}`);
  mkdirSync(dir, { recursive: true });
  const bands: [Uint16Array, Uint16Array, Uint16Array] = [new Uint16Array(grid.w * grid.h), new Uint16Array(grid.w * grid.h), new Uint16Array(grid.w * grid.h)];
  const quality = new Uint8Array(grid.w * grid.h);
  const strips = Math.ceil(grid.h / STRIP);
  for (let k = 0; k < strips; k++) {
    const y0 = k * STRIP;
    const h = Math.min(STRIP, grid.h - y0);
    const file = join(dir, `strip-${String(k).padStart(3, '0')}.bin`);
    let packed: Uint8Array;
    if (existsSync(file)) packed = new Uint8Array(inflateSync(readFileSync(file)));
    else {
      const t0 = Date.now();
      packed = await buildStrip(plan, y0, h);
      writeFileSync(file, deflateSync(packed, { level: 1 }));
      log(`  strip ${k + 1}/${strips} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
    const n = grid.w * h;
    const u16 = new Uint16Array(packed.buffer, packed.byteOffset, n * 3);
    bands[0].set(u16.subarray(0, n), y0 * grid.w);
    bands[1].set(u16.subarray(n, 2 * n), y0 * grid.w);
    bands[2].set(u16.subarray(2 * n, 3 * n), y0 * grid.w);
    quality.set(packed.subarray(6 * n, 7 * n), y0 * grid.w);
  }
  return { grid, bands, quality };
}

async function buildStrip(plan: Plan, y0: number, h: number): Promise<Uint8Array> {
  const { grid } = plan;
  const w = grid.w;
  const n = w * h;
  const sum = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const wsum = new Float32Array(n);
  const best = new Uint8Array(n);
  for (const o of plan.orbits) {
    const takes = plan.takes.filter((t) => t.orbit === o);
    // Each date: reflectance × 10000 and a flag (0 none, 1 cloudy, 2 clear). Two dates at a time keeps memory down.
    const per: { rgb: Uint16Array[]; flag: Uint8Array }[] = [];
    const one = async (take: Take) => {
      // The MGRS tiles of one pass overlap by about 10 km, and Sen2Cor corrects each tile on its own, so the same pixel
      // differs a little between them: blend them with weights that ramp up over TILE_RAMP from each tile's edge.
      const sum = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
      const wsum = new Float32Array(n);
      const rgb = [new Uint16Array(n), new Uint16Array(n), new Uint16Array(n)];
      const flag = new Uint8Array(n);
      for (const s of take.scenes) {
        // Every Sentinel-2 tile of a UTM zone shares one 10 m grid: scene pixel = strip pixel + (dx, dy). (At 40 m the
        // overviews of neighbouring tiles can sit 20 m apart: the nearest pixel is taken.)
        const R = resOf(grid);
        const f = R / 10;
        const size = Math.round(s.size / f);
        const dx = Math.round((grid.e0 - s.e0) / R);
        const dy = Math.round((s.n0 - grid.n0) / R) + y0;
        const sx0 = Math.max(0, dx);
        const sx1 = Math.min(size, dx + w);
        const sy0 = Math.max(0, dy);
        const sy1 = Math.min(size, dy + h);
        if (sx1 <= sx0 || sy1 <= sy0) continue;
        const sw = sx1 - sx0;
        const [r, g, b] = await Promise.all(
          [s.href.red, s.href.green, s.href.blue].map(async (u) => {
            const c = await cog(u);
            return readWindow(c, f === 1 ? 0 : overview(c, f), sx0, sy0, sw, sy1 - sy0);
          }),
        );
        const c = await readSclDilated(s, grid, y0, w, h, !!plan.snowClear);
        const ramp = TILE_RAMP_M / R;
        if (!c) continue;
        const lut = new Uint16Array(65536);
        for (let v = 1; v < 65536; v++) lut[v] = Math.max(0, Math.min(65535, Math.round((v * s.scale + s.offset) * 10000)));
        for (let sy = sy0; sy < sy1; sy++) {
          const y = sy - dy;
          const ey = Math.min(sy, size - 1 - sy);
          for (let sx = sx0; sx < sx1; sx++) {
            const i = y * w + (sx - dx);
            if (!c[i]) continue;
            const k = (sy - sy0) * sw + (sx - sx0);
            const dn = r[k];
            if (!dn) continue;
            const wt = Math.min(1, (Math.min(ey, sx, size - 1 - sx) + 1) / ramp);
            if (c[i] === 2) {
              // A clear view outranks any cloudy one.
              if (flag[i] === 1) {
                sum[0][i] = sum[1][i] = sum[2][i] = wsum[i] = 0;
              }
              flag[i] = 2;
            } else if (flag[i] === 2) continue;
            else flag[i] = 1;
            sum[0][i] += lut[dn] * wt;
            sum[1][i] += lut[g[k]] * wt;
            sum[2][i] += lut[b[k]] * wt;
            wsum[i] += wt;
          }
        }
      }
      for (let i = 0; i < n; i++)
        if (wsum[i] > 0) {
          rgb[0][i] = Math.round(sum[0][i] / wsum[i]);
          rgb[1][i] = Math.round(sum[1][i] / wsum[i]);
          rgb[2][i] = Math.round(sum[2][i] / wsum[i]);
        }
      per.push({ rgb, flag });
    };
    for (let k = 0; k < takes.length; k += 2) await Promise.all(takes.slice(k, k + 2).map(one));
    const gain = plan.gains[o];
    const wmap = plan.weights[o];
    const vals = new Float64Array(64);
    const out = [0, 0, 0];
    for (let y = 0; y < h; y++) {
      // Bilinear weight from the 160 m grid.
      const cy = ((y0 + y + 0.5) * resOf(grid)) / (10 * COARSE) - 0.5;
      const yA = Math.max(0, Math.min(plan.ch - 1, Math.floor(cy)));
      const yB = Math.min(plan.ch - 1, yA + 1);
      const fy = Math.min(1, Math.max(0, cy - yA));
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let clear = 0;
        let any = 0;
        for (const p of per) {
          if (p.flag[i] === 2) clear++;
          if (p.flag[i]) any++;
        }
        if (!any) continue;
        const want = clear ? 2 : 1;
        for (let band = 0; band < 3; band++) {
          let k = 0;
          for (const p of per) if (p.flag[i] >= want) vals[k++] = p.rgb[band][i];
          out[band] = median(vals, k) * gain[band];
        }
        const cx = ((x + 0.5) * resOf(grid)) / (10 * COARSE) - 0.5;
        const xA = Math.max(0, Math.min(plan.cw - 1, Math.floor(cx)));
        const xB = Math.min(plan.cw - 1, xA + 1);
        const fx = Math.min(1, Math.max(0, cx - xA));
        const wv =
          (wmap[yA * plan.cw + xA] * (1 - fx) + wmap[yA * plan.cw + xB] * fx) * (1 - fy) + (wmap[yB * plan.cw + xA] * (1 - fx) + wmap[yB * plan.cw + xB] * fx) * fy;
        const q = Math.max(1e-4, wv) * (clear >= 2 ? 1 : clear === 1 ? 0.4 : 0.01);
        sum[0][i] += out[0] * q;
        sum[1][i] += out[1] * q;
        sum[2][i] += out[2] * q;
        wsum[i] += q;
        best[i] = Math.max(best[i], want);
      }
    }
  }
  const packed = new Uint8Array(n * 7);
  const u16 = new Uint16Array(packed.buffer, 0, n * 3);
  for (let i = 0; i < n; i++) {
    if (!wsum[i]) continue;
    u16[i] = Math.min(65535, Math.round(sum[0][i] / wsum[i]));
    u16[n + i] = Math.min(65535, Math.round(sum[1][i] / wsum[i]));
    u16[2 * n + i] = Math.min(65535, Math.round(sum[2][i] / wsum[i]));
  }
  packed.set(best, 6 * n);
  return packed;
}

/** The scene classification mapped onto a strip of the grid: 0 no data, 1 cloudy (grown by about 60 m), 2 clear. */
async function readSclDilated(s: Scene, grid: Grid, y0: number, w: number, h: number, snowClear: boolean): Promise<Uint8Array | null> {
  const c = await cog(s.href.scl);
  const R = resOf(grid);
  // The classification's own 20 m pixels, or its overview matching a coarser grid.
  const sp = Math.max(20, R);
  const level = sp === 20 ? 0 : overview(c, sp / 20);
  const DILATE = Math.max(1, Math.round(60 / sp));
  const clearSet = snowClear ? CLEAR : CLEAR_NO_SNOW;
  // Scene-pixel window covering the strip plus the dilation margin.
  const eA = grid.e0;
  const eB = grid.e0 + w * R;
  const nA = grid.n0 - y0 * R;
  const nB = grid.n0 - (y0 + h) * R;
  const m = DILATE + 1;
  const sx0 = Math.floor((eA - s.e0) / sp) - m;
  const sx1 = Math.ceil((eB - s.e0) / sp) + m;
  const sy0 = Math.floor((s.n0 - nA) / sp) - m;
  const sy1 = Math.ceil((s.n0 - nB) / sp) + m;
  const ifd = c.ifds[level];
  if (sx1 < 0 || sy1 < 0 || sx0 >= ifd.width || sy0 >= ifd.height) return null;
  const sw = sx1 - sx0;
  const sh = sy1 - sy0;
  const raw = (await readWindow(c, level, sx0, sy0, sw, sh)) as Uint8Array;
  // Cloud flags, then a square dilation (separable max).
  const cloud = new Uint8Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) cloud[i] = CLOUDY.has(raw[i]) || raw[i] === 1 ? 1 : 0;
  const tmp = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      let v = 0;
      for (let d = -DILATE; d <= DILATE && !v; d++) {
        const xx = x + d;
        if (xx >= 0 && xx < sw) v = cloud[y * sw + xx];
      }
      tmp[y * sw + x] = v;
    }
  const grown = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      let v = 0;
      for (let d = -DILATE; d <= DILATE && !v; d++) {
        const yy = y + d;
        if (yy >= 0 && yy < sh) v = tmp[yy * sw + x];
      }
      grown[y * sw + x] = v;
    }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor((s.n0 - (grid.n0 - (y0 + y + 0.5) * R)) / sp) - sy0;
    if (sy < 0 || sy >= sh) continue;
    for (let x = 0; x < w; x++) {
      const sx = Math.floor((grid.e0 + (x + 0.5) * R - s.e0) / sp) - sx0;
      if (sx < 0 || sx >= sw) continue;
      const k = sy * sw + sx;
      const v = raw[k];
      if (!v) continue;
      out[y * w + x] = grown[k] ? 1 : clearSet.has(v) ? 2 : 1;
    }
  }
  return out;
}
