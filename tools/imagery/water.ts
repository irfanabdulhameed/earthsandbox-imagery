// The photo's water: the Sentinel-2 scene classification's water class (6) over the same dates as the composite, a pixel
// being water when most of the dates that see it clearly call it water (the median of a yes/no), on the 20 m grid of the
// classification; plus what the water index (MNDWI: the composite's green against the median short-wave infrared, B11)
// clearly calls water, for the narrow dark rivers and creeks the classifier misses. Then the signed distance to the shore (metres, land positive), which the tiles carry in their alpha
// channel (docs/imagery-tiles.md, "Water and shore").
//
// Only the classification and B11 files are read (20 m: a fraction of the 10 m colour bands), and the votes and the median
// B11 are cached, so a re-run costs nothing.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { cachedCog, readWindow, type Cog } from './cog.ts';
import { resOf, type Composite, type Grid, type Plan } from './composite.ts';

/** The overview level of a COG whose pixel is `factor` times the full-resolution one. */
function overviewOf(c: Cog, factor: number): number {
  const k = c.ifds.findIndex((d) => Math.round(c.ifds[0].width / d.width) === factor);
  if (k < 0) throw new Error(`${c.url}: no ${factor}× overview`);
  return k;
}

const WATER = 6;
const LAND = new Set([2, 4, 5, 7, 11]); // cast shadow, vegetation, bare, unclassified, snow (clouds and no data abstain)
/** MNDWI above which a pixel the classifier left as land is taken for water. */
const MNDWI_WATER = 0.2;

export interface WaterGrid {
  /** Top-left corner (metres) of the grid (20 m, or 80 m for a 40 m composite), its size, and the signed distance to the
   *  shore (m, land positive). */
  e0: number;
  n0: number;
  w: number;
  h: number;
  res: number;
  sdf: Float32Array;
  waterShare: number;
}

const cog = cachedCog;

/** The water grid over a composite's grid: pixels twice the composite's (20 m over 10 m, like the classification's own). */
export function waterGridOf(grid: Grid) {
  const R = resOf(grid);
  const res = 2 * R;
  const e0 = Math.floor(grid.e0 / res) * res;
  const n0 = Math.ceil(grid.n0 / res) * res;
  const w = Math.ceil((grid.e0 + grid.w * R - e0) / res);
  const h = Math.ceil((n0 - (grid.n0 - grid.h * R)) / res);
  return { e0, n0, w, h, res };
}

/**
 * Per 20 m pixel over the plan's dates: water votes and clear votes from the scene classification, and the median
 * short-wave infrared (B11, 20 m) reflectance × 10000 of the clear dates (cached). Read in row bands to keep memory low.
 */
async function votes(plan: Plan, cacheDir: string, key: string, log: (s: string) => void) {
  const g = waterGridOf(plan.grid);
  const n = g.w * g.h;
  const file = join(cacheDir, `water-votes-${key}-v2-${g.res}.bin`);
  if (existsSync(file)) {
    const b = new Uint8Array(inflateSync(readFileSync(file)));
    return { g, water: b.subarray(0, n), seen: b.subarray(n, 2 * n), swir: new Uint16Array(b.buffer.slice(b.byteOffset + 2 * n, b.byteOffset + 4 * n)) };
  }
  const water = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const swir = new Uint16Array(n);
  const BAND = 1600;
  const bands = Math.ceil(g.h / BAND);
  for (let band = 0; band < bands; band++) {
    const r0 = band * BAND;
    const rh = Math.min(BAND, g.h - r0);
    const m = g.w * rh;
    const perTake: Uint16Array[] = [];
    for (const take of plan.takes) {
      // One class (and one SWIR value) per pixel per pass: the first of the pass's tiles that sees it.
      const cls = new Uint8Array(m);
      const sw = new Uint16Array(m);
      for (const s of take.scenes) {
        const c = await cog(s.href.scl);
        const f = g.res / 20;
        const level = f === 1 ? 0 : overviewOf(c, f);
        const dx = Math.round((g.e0 - s.e0) / g.res);
        const dy = Math.round((s.n0 - g.n0) / g.res) + r0;
        const size = c.ifds[level].width;
        const sx0 = Math.max(0, dx);
        const sx1 = Math.min(size, dx + g.w);
        const sy0 = Math.max(0, dy);
        const sy1 = Math.min(size, dy + rh);
        if (sx1 <= sx0 || sy1 <= sy0) continue;
        const ww = sx1 - sx0;
        const [raw, b11] = await Promise.all([
          readWindow(c, level, sx0, sy0, ww, sy1 - sy0) as Promise<Uint8Array>,
          cog(s.href.red.replace(/B04\.tif$/, 'B11.tif')).then((b) => readWindow(b, f === 1 ? 0 : overviewOf(b, f), sx0, sy0, ww, sy1 - sy0) as Promise<Uint16Array>),
        ]);
        for (let sy = sy0; sy < sy1; sy++) {
          const row = (sy - dy) * g.w - dx;
          const src = (sy - sy0) * ww - sx0;
          for (let sx = sx0; sx < sx1; sx++)
            if (!cls[row + sx] && raw[src + sx]) {
              cls[row + sx] = raw[src + sx];
              const dn = b11[src + sx];
              sw[row + sx] = dn ? Math.max(1, Math.round((dn * s.scale + s.offset) * 10000)) : 0;
            }
        }
      }
      for (let i = 0; i < m; i++) {
        const v = cls[i];
        const o = r0 * g.w + i;
        if (v === WATER) {
          water[o]++;
          seen[o]++;
        } else if (LAND.has(v)) seen[o]++;
        else sw[i] = 0; // clouds and no data give no SWIR either
      }
      perTake.push(sw);
    }
    const vals = new Uint16Array(perTake.length);
    for (let i = 0; i < m; i++) {
      let k = 0;
      for (const t of perTake) if (t[i]) vals[k++] = t[i];
      if (!k) continue;
      const sorted = vals.subarray(0, k).sort();
      swir[r0 * g.w + i] = sorted[(k - 1) >> 1];
    }
    log(`  water: row band ${band + 1}/${bands} read (${plan.takes.length} dates)`);
  }
  const packed = new Uint8Array(4 * n);
  packed.set(water, 0);
  packed.set(seen, n);
  packed.set(new Uint8Array(swir.buffer), 2 * n);
  writeFileSync(file, deflateSync(packed, { level: 6 }));
  return { g, water, seen, swir };
}

/** Exact squared Euclidean distance transform along one line (Felzenszwalb and Huttenlocher). */
function edt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Distance (in pixels) from every pixel to the nearest pixel where `target(i)` holds. */
export function distanceTo(w: number, h: number, target: (i: number) => boolean): Float32Array {
  const BIG = 1e12;
  const out = new Float32Array(w * h);
  const m = Math.max(w, h);
  const f = new Float64Array(m);
  const d = new Float64Array(m);
  const v = new Int32Array(m);
  const z = new Float64Array(m + 1);
  const tmp = new Float64Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = target(y * w + x) ? 0 : BIG;
    edt1(f, h, d, v, z);
    for (let y = 0; y < h; y++) tmp[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = tmp[y * w + x];
    edt1(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]);
  }
  return out;
}

/**
 * The water mask and its signed distance to the shore. A pixel is water when most of its clear dates classify it as water,
 * or when its modified normalised difference water index (green against short-wave infrared, MNDWI) is clearly
 * positive: the classifier misses narrow, dark rivers and mangrove creeks, which the index catches.
 */
export async function buildWater(plan: Plan, comp: Composite, cacheDir: string, key: string, log: (s: string) => void): Promise<WaterGrid> {
  const { g, water, seen, swir } = await votes(plan, cacheDir, key, log);
  const n = g.w * g.h;
  const isWater = new Uint8Array(n);
  let count = 0;
  let byIndex = 0;
  const grid = comp.grid;
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      const i = y * g.w + x;
      let wet = seen[i] > 0 && 2 * water[i] > seen[i];
      if (!wet && swir[i]) {
        // The composite's green over this water pixel (its four composite pixels).
        let gsum = 0;
        let gn = 0;
        const R = resOf(grid);
        const cx = Math.round((g.e0 + x * g.res - grid.e0) / R);
        const cy = Math.round((grid.n0 - (g.n0 - y * g.res)) / R);
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const xx = cx + dx;
            const yy = cy + dy;
            if (xx < 0 || yy < 0 || xx >= grid.w || yy >= grid.h) continue;
            const k = yy * grid.w + xx;
            if (!comp.quality[k]) continue;
            gsum += comp.bands[1][k];
            gn++;
          }
        if (gn) {
          const green = gsum / gn;
          const mndwi = (green - swir[i]) / Math.max(1, green + swir[i]);
          // The index alone is trusted only when clearly water; a weaker reading needs one date's classifier to agree
          // (dark roofs and deep shadow can read weakly positive).
          if (mndwi > 2 * MNDWI_WATER || (mndwi > MNDWI_WATER && water[i] > 0)) {
            wet = true;
            byIndex++;
          }
        }
      }
      isWater[i] = wet ? 1 : 0;
      count += isWater[i];
    }
  const toWater = distanceTo(g.w, g.h, (i) => isWater[i] === 1);
  const toLand = distanceTo(g.w, g.h, (i) => isWater[i] === 0);
  const sdf = new Float32Array(n);
  // Distances run between pixel centres; the shore is half a pixel from the last pixel on either side.
  for (let i = 0; i < n; i++) sdf[i] = isWater[i] ? -(toLand[i] - 0.5) * g.res : (Math.min(toWater[i], 1e6) - 0.5) * g.res;
  log(`  water: ${((100 * count) / n).toFixed(1)}% of the ${g.res} m pixels are water (${((100 * byIndex) / n).toFixed(2)}% added by the water index)`);
  return { ...g, sdf, waterShare: count / n };
}

/** Bilinear signed distance (m, land positive) at easting and northing, or NaN off the grid. */
export function sdfAt(wg: WaterGrid, e: number, n: number): number {
  const fx = (e - wg.e0) / wg.res - 0.5;
  const fy = (wg.n0 - n) / wg.res - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= wg.w || y0 + 1 >= wg.h) return NaN;
  const tx = fx - x0;
  const ty = fy - y0;
  const i = y0 * wg.w + x0;
  const s = wg.sdf;
  return (s[i] * (1 - tx) + s[i + 1] * tx) * (1 - ty) + (s[i + wg.w] * (1 - tx) + s[i + wg.w + 1] * tx) * ty;
}
