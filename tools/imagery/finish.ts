// From the composite to the archive: colour, the level pyramid, the cube-sphere tiles and the file.
//
// Colour, one fixed setting for every region (never per scene, never per tile), so archives agree where they meet:
//   reflectance − a gentle dark-object offset (half the 0.2nd percentile of the region: residual haze)
//   → (gain_b · r)^p in linear light: a natural true-colour curve (forest dark green, laterite and fields tan, sand
//     near white), with a hair of extra gain in green and blue, the look of the big online photo maps
//   → a soft shoulder for bright roofs, sand and surf, then sRGB.
// color-8k (Blue Marble, July: the monsoon) is much darker and greener than a dry-season photo, so the large-scale match
// is not baked into the pixels: the archive carries a match field (metadata "match": per-band multipliers in linear light
// on color-8k's own pixel grid) that turns the photo's large-scale colour into color-8k's. A renderer applies it fully
// where the photo first replaces color-8k and fades it out as the camera comes down (docs/imagery-tiles.md), so the
// hand-over is seamless and the close-up keeps the natural colour. MATCH bakes a share of it into the pixels (0 here).
// The pyramid is averaged in linear light. Level `maxLevel` is resampled bicubically from the 10 m composite; coarser
// levels blend the two nearest pyramid steps. Alpha is the box feather times the coverage (see docs/imagery-tiles.md).

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { FLAG_ALPHA, FLAG_WATER, VERSION, writeArchive } from './archive.ts';
import { buildWater, sdfAt, type WaterGrid } from './water.ts';
import { resOf, type Composite, type Plan } from './composite.ts';
import { dirToFace, dirToLatLon, faceToDir, GUTTER_PX, INNER_PX, latLonToDir, pixelMetres, TILE_PX, tileBounds, tileSpan } from './cube.ts';
import { CACHE, type Options } from './make.ts';
import { fromUtm, toUtm } from './utm.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
export const FEATHER_KM = 3;
/** Alpha of the shore (the water's edge), its steps per pixel of the level, and the lowest value with a picture. */
export const SHORE_ALPHA = 192;
export const SHORE_STEPS = 2;
export const SHORE_MIN = 129;
/** The natural tone: linear = (GAIN_b · reflectance)^POWER, then saturation SAT about the luminance. */
export const TONE = { gain: [4.3, 4.43, 4.64] as [number, number, number], power: 1.65, sat: 1.0 };
const MATCH = 0; // share of the color-8k match baked into the pixels
const SHOULDER = 0.82;
const C8K_W = 8192;
const C8K_H = 4096;

export const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export const linearToSrgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};
const shoulder = (x: number) => (x <= SHOULDER ? x : SHOULDER + (1 - SHOULDER) * (1 - Math.exp(-(x - SHOULDER) / (1 - SHOULDER))));

export interface MatchField {
  /** Placement on color-8k's 8192 × 4096 grid: the field's first cell is color-8k pixel (col0, row0). */
  col0: number;
  row0: number;
  cols: number;
  rows: number;
  /** rows × cols × 3 linear multipliers (north row first), smooth at about 5 km. */
  data: Float32Array;
}

export interface ColourFit {
  dark: [number, number, number];
  field: MatchField;
}

/** Bilinear lookup of a match field at a latitude and longitude (cell centres at color-8k pixel centres; clamped). */
export function fieldAt(f: MatchField, lat: number, lon: number, out: number[]) {
  const cx = ((lon + 180) / 360) * C8K_W - 0.5 - f.col0;
  const cy = ((90 - lat) / 180) * C8K_H - 0.5 - f.row0;
  const x0 = Math.max(0, Math.min(f.cols - 1, Math.floor(cx)));
  const y0 = Math.max(0, Math.min(f.rows - 1, Math.floor(cy)));
  const x1 = Math.min(f.cols - 1, x0 + 1);
  const y1 = Math.min(f.rows - 1, y0 + 1);
  const fx = Math.min(1, Math.max(0, cx - x0));
  const fy = Math.min(1, Math.max(0, cy - y0));
  for (let b = 0; b < 3; b++) {
    const g = (x: number, y: number) => f.data[(y * f.cols + x) * 3 + b];
    out[b] = (g(x0, y0) * (1 - fx) + g(x1, y0) * fx) * (1 - fy) + (g(x0, y1) * (1 - fx) + g(x1, y1) * fx) * fy;
  }
}

/** The dark offsets and the match field to color-8k. */
export async function fitColour(comp: Composite, bbox: number[], log: (s: string) => void): Promise<ColourFit> {
  const { grid, bands, quality } = comp;
  const c8k = await sharp(join(ROOT, 'public/earth/color-8k.avif')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  // Dark-object offsets from a sparse sample of clear pixels.
  const samples: number[][] = [[], [], []];
  for (let i = 0; i < grid.w * grid.h; i += 97) if (quality[i] === 2) for (let b = 0; b < 3; b++) samples[b].push(bands[b][i] / 10000);
  const dark = samples.map((s) => {
    s.sort((x, y) => x - y);
    return 0.5 * s[Math.floor(s.length * 0.002)];
  }) as [number, number, number];

  // The photo's mean linear colour over each color-8k pixel inside the box, against color-8k's.
  const col0 = Math.floor(((bbox[0] + 180) / 360) * C8K_W) - 2;
  const col1 = Math.ceil(((bbox[2] + 180) / 360) * C8K_W) + 2;
  const row0 = Math.floor(((90 - bbox[3]) / 180) * C8K_H) - 2;
  const row1 = Math.ceil(((90 - bbox[1]) / 180) * C8K_H) + 2;
  const cols = col1 - col0;
  const rows = row1 - row0;
  const ratio = new Float32Array(cols * rows * 3).fill(NaN);
  const tone = [0, 0, 0];
  let pairs = 0;
  const sumP = [0, 0, 0];
  const sumT = [0, 0, 0];
  for (let row = row0; row < row1; row++)
    for (let col = col0; col < col1; col++) {
      const lonA = (col / C8K_W) * 360 - 180;
      const lonB = ((col + 1) / C8K_W) * 360 - 180;
      const latA = 90 - ((row + 1) / C8K_H) * 180;
      const latB = 90 - (row / C8K_H) * 180;
      // Every color-8k pixel the composite covers at least 40% of (it runs 1.5 km past the box, so edge pixels count).
      if (lonB < bbox[0] || lonA > bbox[2] || latB < bbox[1] || latA > bbox[3]) continue;
      const R = resOf(grid);
      const expected = (((lonB - lonA) * 111320 * Math.cos((((latA + latB) / 2) * Math.PI) / 180)) / R) * (((latB - latA) * 111320) / R);
      const corners = [toUtm(latA, lonA, grid.zone), toUtm(latA, lonB, grid.zone), toUtm(latB, lonA, grid.zone), toUtm(latB, lonB, grid.zone)];
      const x0 = Math.max(0, Math.floor((Math.min(...corners.map((c) => c.e)) - grid.e0) / R));
      const x1 = Math.min(grid.w, Math.ceil((Math.max(...corners.map((c) => c.e)) - grid.e0) / R));
      const y0 = Math.max(0, Math.floor((grid.n0 - Math.max(...corners.map((c) => c.n))) / R));
      const y1 = Math.min(grid.h, Math.ceil((grid.n0 - Math.min(...corners.map((c) => c.n))) / R));
      const s = [0, 0, 0];
      let n = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = y * grid.w + x;
          if (!quality[i]) continue;
          toneGlobal(bands[0][i], bands[1][i], bands[2][i], dark, tone);
          s[0] += shoulder(tone[0]);
          s[1] += shoulder(tone[1]);
          s[2] += shoulder(tone[2]);
          n++;
        }
      if (n < 0.4 * expected) continue;
      const k = (row - row0) * cols + (col - col0);
      for (let b = 0; b < 3; b++) {
        const t = srgbToLinear(c8k.data[(row * C8K_W + col) * 3 + b] / 255);
        const p = s[b] / n;
        ratio[k * 3 + b] = Math.log(Math.min(8, Math.max(1 / 64, Math.max(1e-4, t) / Math.max(1e-4, p))));
        sumP[b] += p;
        sumT[b] += t;
      }
      pairs++;
    }
  // Smooth the log ratio a little (Gaussian, sigma one color-8k pixel, about 5 km) so it has no pixel steps, but keeps
  // coasts (the sea in color-8k is far darker than the photographed sea); fade to no change away from data.
  const data = new Float32Array(cols * rows * 3);
  const sigma = 1;
  const rad = 3;
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++)
      for (let b = 0; b < 3; b++) {
        let s = 0;
        let ws = 0;
        for (let dy = -rad; dy <= rad; dy++)
          for (let dx = -rad; dx <= rad; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
            const v = ratio[(yy * cols + xx) * 3 + b];
            if (Number.isNaN(v)) continue;
            const wgt = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
            s += v * wgt;
            ws += wgt;
          }
        data[(y * cols + x) * 3 + b] = ws > 0.05 ? Math.exp((s / ws) * Math.min(1, ws / 1.2)) : 1;
      }
  const srgb = (v: number[]) => v.map((x) => Math.round(255 * linearToSrgb(x / pairs))).join(',');
  log(`  colour: dark offsets ${dark.map((v) => v.toFixed(4)).join('/')}; over ${pairs} color-8k pixels the photo averages sRGB ${srgb(sumP)}, color-8k ${srgb(sumT)}`);
  return { dark, field: { col0, row0, cols, rows, data } };
}

/** The tone before the shoulder: reflectance × 10000 to linear display colour. */
export function toneGlobal(r: number, g: number, b: number, dark: number[], out: number[]) {
  const lr = (Math.max(0, r / 10000 - dark[0]) * TONE.gain[0]) ** TONE.power;
  const lg = (Math.max(0, g / 10000 - dark[1]) * TONE.gain[1]) ** TONE.power;
  const lb = (Math.max(0, b / 10000 - dark[2]) * TONE.gain[2]) ** TONE.power;
  const y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  out[0] = Math.max(0, y + TONE.sat * (lr - y));
  out[1] = Math.max(0, y + TONE.sat * (lg - y));
  out[2] = Math.max(0, y + TONE.sat * (lb - y));
}

/**
 * Bright ground (deserts, salt, sand) keeps its hue: luminance above HL_KNEE is rolled off towards HL_MAX and the three
 * channels scaled with it, so a desert is pale tan, not white. The world's shards use it; vegetation and soils (below
 * the knee) are untouched.
 */
const HL_KNEE = 0.2;
const HL_MAX = 0.8;
export function rollHighlights(c: number[]) {
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  if (y <= HL_KNEE) return;
  const d = y - HL_KNEE;
  const k = (HL_KNEE + d / (1 + d / (HL_MAX - HL_KNEE))) / y;
  c[0] *= k;
  c[1] *= k;
  c[2] *= k;
}

/** The toned picture in linear light, 16-bit, and its pyramid (each step halves the size by averaging). */
export function toneAndPyramid(comp: Composite, fit: ColourFit, opts: { highlights?: boolean } = {}) {
  const { grid, bands } = comp;
  const n = grid.w * grid.h;
  const lin = [new Uint16Array(n), new Uint16Array(n), new Uint16Array(n)];
  const tone = [0, 0, 0];
  const corr = [1, 1, 1];
  for (let y = 0; y < grid.h; y++) {
    // The correction field changes slowly: look it up every 16 pixels along the row.
    for (let x = 0; x < grid.w; x++) {
      const i = y * grid.w + x;
      if (!comp.quality[i]) continue;
      if (MATCH && x % 16 === 0) {
        const p = fromUtm(grid.e0 + (x + 8) * resOf(grid), grid.n0 - (y + 0.5) * resOf(grid), grid.zone);
        fieldAt(fit.field, p.lat, p.lon, corr);
        for (let b = 0; b < 3; b++) corr[b] = corr[b] ** MATCH;
      }
      toneGlobal(bands[0][i], bands[1][i], bands[2][i], fit.dark, tone);
      if (opts.highlights) rollHighlights(tone);
      for (let b = 0; b < 3; b++) lin[b][i] = Math.round(Math.min(1, shoulder(tone[b]) * corr[b]) * 65535);
    }
  }
  const pyramid: { w: number; h: number; c: Uint16Array[]; q: Uint8Array }[] = [{ w: grid.w, h: grid.h, c: lin, q: comp.quality }];
  while (pyramid.length < 12) {
    const p = pyramid[pyramid.length - 1];
    if (p.w < 4 || p.h < 4) break;
    const w = Math.ceil(p.w / 2);
    const h = Math.ceil(p.h / 2);
    const c = [new Uint16Array(w * h), new Uint16Array(w * h), new Uint16Array(w * h)];
    const q = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const s = [0, 0, 0];
        let k = 0;
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const xx = 2 * x + dx;
            const yy = 2 * y + dy;
            if (xx >= p.w || yy >= p.h) continue;
            const i = yy * p.w + xx;
            if (!p.q[i]) continue;
            s[0] += p.c[0][i];
            s[1] += p.c[1][i];
            s[2] += p.c[2][i];
            k++;
          }
        if (!k) continue;
        const o = y * w + x;
        for (let b = 0; b < 3; b++) c[b][o] = Math.round(s[b] / k);
        q[o] = 1;
      }
    pyramid.push({ w, h, c, q });
  }
  return pyramid;
}

export type Pyramid = ReturnType<typeof toneAndPyramid>;

const cubic = (t: number) => {
  // Catmull-Rom weights for offsets −1, 0, 1, 2.
  const t2 = t * t;
  const t3 = t2 * t;
  return [-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1, -1.5 * t3 + 2 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2];
};

/** Samples pyramid step m at continuous pixel coordinates of step 0 (pixel centres at k + 0.5). Returns false off the data. */
export function sample(pyr: Pyramid, m: number, fx0: number, fy0: number, bicubic: boolean, out: number[]): boolean {
  const p = pyr[Math.min(m, pyr.length - 1)];
  const scale = 2 ** Math.min(m, pyr.length - 1);
  const fx = fx0 / scale - 0.5;
  const fy = fy0 / scale - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= p.w || y0 + 1 >= p.h) return false;
  const tx = fx - x0;
  const ty = fy - y0;
  if (bicubic && x0 >= 1 && y0 >= 1 && x0 + 2 < p.w && y0 + 2 < p.h) {
    const wx = cubic(tx);
    const wy = cubic(ty);
    for (let b = 0; b < 3; b++) {
      let s = 0;
      const c = p.c[b];
      for (let j = 0; j < 4; j++) {
        const row = (y0 - 1 + j) * p.w + x0 - 1;
        s += wy[j] * (wx[0] * c[row] + wx[1] * c[row + 1] + wx[2] * c[row + 2] + wx[3] * c[row + 3]);
      }
      out[b] = Math.max(0, Math.min(65535, s));
    }
    return true;
  }
  const i = y0 * p.w + x0;
  for (let b = 0; b < 3; b++) {
    const c = p.c[b];
    out[b] = (c[i] * (1 - tx) + c[i + 1] * tx) * (1 - ty) + (c[i + p.w] * (1 - tx) + c[i + p.w + 1] * tx) * ty;
  }
  return true;
}

export interface TileOut {
  face: number;
  level: number;
  x: number;
  y: number;
  flags: number;
  data: Uint8Array;
  coverage: number;
}

/** Feathered coverage of the box at a point (1 deep inside, 0 outside). */
export function boxAlpha(bbox: number[], lat: number, lon: number): number {
  const kmLat = 111.32;
  const kmLon = 111.32 * Math.cos((lat * Math.PI) / 180);
  const d = Math.min((lat - bbox[1]) * kmLat, (bbox[3] - lat) * kmLat, (lon - bbox[0]) * kmLon, (bbox[2] - lon) * kmLon);
  return smooth(d / FEATHER_KM);
}

/** Renders one tile's RGBA pixels (8-bit sRGB, straight alpha). */
export function renderTile(
  pyr: Pyramid,
  comp: Composite,
  water: WaterGrid,
  bbox: number[],
  face: number,
  level: number,
  x: number,
  y: number,
  maxLevel: number,
  /** The level's pixel size (m) that the shore distance in the alpha channel is counted in (metadata levels[].pixelM). */
  levelM: number,
): { rgba: Uint8Array; covered: number; full: boolean; water: boolean } {
  const { grid } = comp;
  const { s, a0, b1 } = tileBounds(level, x, y);
  const STEP = 16;
  const K = TILE_PX / STEP + 1;
  // Exact mapping on a 33 × 33 control grid of image positions, interpolated between (the mapping is smooth).
  const ce = new Float64Array(K * K);
  const cn = new Float64Array(K * K);
  const clat = new Float64Array(K * K);
  const clon = new Float64Array(K * K);
  for (let j = 0; j < K; j++)
    for (let i = 0; i < K; i++) {
      const a = a0 + ((i * STEP - GUTTER_PX) * s) / INNER_PX;
      const b = b1 - ((j * STEP - GUTTER_PX) * s) / INNER_PX;
      const ll = dirToLatLon(faceToDir(face, a, b));
      const u = toUtm(ll.lat, ll.lon, grid.zone);
      const k = j * K + i;
      ce[k] = u.e;
      cn[k] = u.n;
      clat[k] = ll.lat;
      clon[k] = ll.lon;
    }
  const centre = pixelMetres(level, a0 + s / 2, b1 - s / 2);
  const ratio = centre / resOf(grid);
  const mf = Math.max(0, Math.log2(ratio));
  const m0 = Math.floor(mf);
  const mt = mf - m0;
  const bicubic = level >= maxLevel || ratio < 1.25;
  const lut = srgbLut();
  const rgba = new Uint8Array(TILE_PX * TILE_PX * 4);
  const c0 = [0, 0, 0];
  const c1 = [0, 0, 0];
  let covered = 0;
  let full = true;
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
      let alpha = boxAlpha(bbox, lat, lon);
      const o = (j * TILE_PX + i) * 4;
      // Colour wherever the composite has a picture (it runs 1.5 km past the box), so pixels under a fading or zero
      // alpha still hold real colour and filtering never pulls black in at the edge.
      const fx = (lerp(ce) - grid.e0) / resOf(grid);
      const fy = (grid.n0 - lerp(cn)) / resOf(grid);
      const pm = pyr[Math.min(m0, pyr.length - 1)];
      const sc = 2 ** Math.min(m0, pyr.length - 1);
      const qx = Math.floor(fx / sc);
      const qy = Math.floor(fy / sc);
      const ok = qx >= 0 && qy >= 0 && qx < pm.w && qy < pm.h && pm.q[qy * pm.w + qx] > 0 && sample(pyr, m0, fx, fy, bicubic && m0 === 0, c0);
      if (!ok) alpha = 0;
      else {
        if (mt > 0.001 && sample(pyr, m0 + 1, fx, fy, false, c1)) for (let b = 0; b < 3; b++) c0[b] = c0[b] * (1 - mt) + c1[b] * mt;
        rgba[o] = lut[Math.round(c0[0])];
        rgba[o + 1] = lut[Math.round(c0[1])];
        rgba[o + 2] = lut[Math.round(c0[2])];
      }
      // Alpha: 0 where there is no picture; else the signed distance to the shore, land positive, in half pixels of this
      // level about 192 (129 deep water .. 255 deep land). The box's feather is not in it: a renderer works it out.
      let a8 = 0;
      if (ok) {
        const d = sdfAt(water, lerp(ce), lerp(cn));
        a8 = Number.isNaN(d) ? 255 : Math.max(SHORE_MIN, Math.min(255, Math.round(SHORE_ALPHA + (SHORE_STEPS * d) / levelM)));
        if (a8 < SHORE_ALPHA) wet = true;
      }
      rgba[o + 3] = a8;
      if (alpha > 0 && a8 > 0) covered++;
      if (alpha < 1) full = false;
    }
  }
  return { rgba, covered, full, water: wet };
}

let lutCache: Uint8Array | null = null;
export function srgbLut(): Uint8Array {
  if (!lutCache) {
    lutCache = new Uint8Array(65536);
    for (let v = 0; v < 65536; v++) lutCache[v] = Math.round(Math.min(1, Math.max(0, linearToSrgb(v / 65535))) * 255);
  }
  return lutCache;
}

/** The tiles of a level that the box touches, on every face it reaches. */
export function tilesForBox(bbox: number[], level: number): { face: number; x: number; y: number }[] {
  const ranges = new Map<number, { a0: number; a1: number; b0: number; b1: number }>();
  const N = 120;
  for (let j = 0; j <= N; j++)
    for (let i = 0; i <= N; i++) {
      const lat = bbox[1] + ((bbox[3] - bbox[1]) * j) / N;
      const lon = bbox[0] + ((bbox[2] - bbox[0]) * i) / N;
      const { face, a, b } = dirToFace(latLonToDir(lat, lon));
      const r = ranges.get(face) ?? { a0: a, a1: a, b0: b, b1: b };
      ranges.set(face, { a0: Math.min(r.a0, a), a1: Math.max(r.a1, a), b0: Math.min(r.b0, b), b1: Math.max(r.b1, b) });
    }
  const out: { face: number; x: number; y: number }[] = [];
  const n = 2 ** level;
  const s = tileSpan(level);
  for (const [face, r] of [...ranges.entries()].sort((p, q) => p[0] - q[0])) {
    const x0 = Math.max(0, Math.floor((r.a0 + 1) / s) - 1);
    const x1 = Math.min(n - 1, Math.floor((r.a1 + 1) / s) + 1);
    const y0 = Math.max(0, Math.floor((r.b0 + 1) / s) - 1);
    const y1 = Math.min(n - 1, Math.floor((r.b1 + 1) / s) + 1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ face, x, y });
  }
  return out;
}

export async function encodeTile(rgba: Uint8Array, full: boolean, quality: number): Promise<Uint8Array> {
  const px = TILE_PX * TILE_PX;
  let raw: Uint8Array = rgba;
  let channels: 3 | 4 = 4;
  if (full) {
    raw = new Uint8Array(px * 3);
    for (let i = 0; i < px; i++) {
      raw[i * 3] = rgba[i * 4];
      raw[i * 3 + 1] = rgba[i * 4 + 1];
      raw[i * 3 + 2] = rgba[i * 4 + 2];
    }
    channels = 3;
  }
  const buf = await sharp(raw, { raw: { width: TILE_PX, height: TILE_PX, channels } })
    .webp({ quality, effort: 6, smartSubsample: true, alphaQuality: 100 })
    .toBuffer();
  return new Uint8Array(buf);
}

export async function finish(opts: Options, plan: Plan, comp: Composite, key: string, log: (s: string) => void) {
  const fit = await fitColour(comp, opts.bbox, log);
  const pyr = toneAndPyramid(comp, fit);
  log(`  toned and made a ${pyr.length}-step pyramid`);
  const water = await buildWater(plan, comp, CACHE, key, log);
  const tiles: TileOut[] = [];
  const levels: { level: number; tiles: number; bytes: number; pixelM: number }[] = [];
  const mid = dirToFace(latLonToDir((opts.bbox[1] + opts.bbox[3]) / 2, (opts.bbox[0] + opts.bbox[2]) / 2));
  let benchKept = 0;
  for (let level = opts.maxLevel; level >= opts.minLevel; level--) {
    const cands = tilesForBox(opts.bbox, level);
    // The level's pixel at the region's centre, as written to the metadata: the unit of the shore distance in alpha.
    const levelM = Math.round(pixelMetres(level, mid.a, mid.b) * 100) / 100;
    let count = 0;
    let bytes = 0;
    const pending: Promise<void>[] = [];
    for (const c of cands) {
      const r = renderTile(pyr, comp, water, opts.bbox, c.face, level, c.x, c.y, opts.maxLevel, levelM);
      if (!r.covered) continue;
      if (level === opts.maxLevel && r.full && benchKept < opts.bench && (c.x + c.y) % 7 === 0) {
        mkdirSync(join(CACHE, 'bench'), { recursive: true });
        writeFileSync(join(CACHE, 'bench', `${c.face}-${level}-${c.x}-${c.y}.rgba`), r.rgba);
        benchKept++;
      }
      pending.push(
        encodeTile(r.rgba, false, opts.quality).then((data) => {
          tiles.push({ ...c, level, flags: FLAG_ALPHA | (r.water ? FLAG_WATER : 0), data, coverage: r.covered / (TILE_PX * TILE_PX) });
          count++;
          bytes += data.length;
        }),
      );
      if (pending.length >= 8) await Promise.all(pending.splice(0));
    }
    await Promise.all(pending);
    levels.push({ level, tiles: count, bytes, pixelM: levelM });
    log(`  level ${level}: ${count} tiles, ${(bytes / 1e6).toFixed(2)} MB, ${levelM.toFixed(1)} m a pixel`);
  }
  levels.sort((p, q) => p.level - q.level);
  const scenes = plan.takes.flatMap((t) => t.scenes.map((s) => s.id)).sort();
  const meta = {
    version: VERSION,
    name: opts.name,
    bbox: opts.bbox,
    format: 'webp',
    mime: 'image/webp',
    tileSize: TILE_PX,
    gutter: GUTTER_PX,
    inner: INNER_PX,
    minLevel: opts.minLevel,
    maxLevel: opts.maxLevel,
    colourSpace: 'srgb',
    alpha: 'straight',
    featherKm: FEATHER_KM,
    // Version 2: alpha is the signed distance to the shore (see the contract), not coverage.
    shore: { alpha: SHORE_ALPHA, stepsPerPixel: SHORE_STEPS, min: SHORE_MIN, max: 255, none: 0, landPositive: true, source: 'Sentinel-2 scene classification (water class, majority of the clear dates), or MNDWI (composite green, median B11) over 0.2' },
    waterShare: Math.round(water.waterShare * 1000) / 1000,
    levels,
    source: 'Contains modified Copernicus Sentinel data (Sentinel-2 L2A, collection 1), read from Earth Search on AWS',
    dates: [...new Set(plan.takes.map((t) => t.date))].sort(),
    scenes,
    colour: { dark: fit.dark.map((v) => +v.toFixed(5)), gain: TONE.gain, power: TONE.power, saturation: TONE.sat, bakedMatch: MATCH },
    // Multiply the photo's linear colour by this (per band) to get color-8k's large-scale colour; see the contract.
    match: {
      grid: 'color-8k',
      width: C8K_W,
      height: C8K_H,
      col0: fit.field.col0,
      row0: fit.field.row0,
      cols: fit.field.cols,
      rows: fit.field.rows,
      baked: MATCH,
      data: Array.from(fit.field.data, (v) => Math.round((MATCH ? v ** (1 - MATCH) : v) * 1000) / 1000),
    },
    tool: `tools/imagery, composite ${key}, quality ${opts.quality}`,
  };
  const archive = writeArchive(meta, tiles);
  mkdirSync(opts.out, { recursive: true });
  const file = `${opts.name}.bin`;
  writeFileSync(join(opts.out, file), archive);
  // The list of archives.
  const listFile = join(opts.out, 'regions.json');
  const list = existsSync(listFile) ? (JSON.parse(readFileSync(listFile, 'utf8')) as { version: number; regions: Record<string, unknown>[] }) : { version: 1, regions: [] };
  list.regions = list.regions.filter((r) => r.name !== opts.name);
  list.regions.push({ name: opts.name, file, bytes: archive.length, bbox: opts.bbox, minLevel: opts.minLevel, maxLevel: opts.maxLevel, format: 'webp' });
  list.regions.sort((p, q) => String(p.name).localeCompare(String(q.name)));
  writeFileSync(listFile, `${JSON.stringify(list, null, 2)}\n`);
  log(`wrote ${join(opts.out, file)}: ${(archive.length / 1e6).toFixed(2)} MB, ${tiles.length} tiles, levels ${opts.minLevel}–${opts.maxLevel}`);
  return { archive, meta, fit };
}

