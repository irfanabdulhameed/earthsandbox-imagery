// Looks at a photo map archive the way a renderer would: reads its header and index, picks the level for a view,
// finds tiles by the cube-sphere addressing, samples them with the gutter, and mixes them over color-8k by alpha.
// Writes north-up views and a side-by-side with a reference picture into reports/shots/photo-map/.
//
//   npx tsx tools/imagery/check.ts --archive public/imagery/karnataka-coast.bin [--reference picture.png]

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { readArchiveHead, tileKey, type ArchiveHead } from './archive.ts';
import { latLonToTilePixel, TILE_PX } from './cube.ts';
import { boxAlpha, fieldAt, linearToSrgb, srgbToLinear, type MatchField } from './finish.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
const OUT = join(ROOT, 'reports/shots/photo-map');

export class ArchiveView {
  head: ArchiveHead;
  private tiles = new Map<string, Promise<Uint8Array | null>>();
  constructor(private bytes: Uint8Array) {
    this.head = readArchiveHead(bytes);
  }
  get levels(): { level: number; pixelM: number }[] {
    return this.head.meta.levels as { level: number; pixelM: number }[];
  }
  /** Decoded RGBA of a tile, or null when the archive has none. */
  tile(face: number, level: number, x: number, y: number): Promise<Uint8Array | null> {
    const key = tileKey(face, level, x, y);
    let t = this.tiles.get(key);
    if (!t) {
      const e = this.head.byKey.get(key);
      t = e
        ? sharp(this.bytes.subarray(e.offset, e.offset + e.length))
            .ensureAlpha()
            .raw()
            .toBuffer()
            .then((b) => new Uint8Array(b))
        : Promise.resolve(null);
      this.tiles.set(key, t);
    }
    return t;
  }
}

async function loadColor8k() {
  const { data, info } = await sharp(join(ROOT, 'public/earth/color-8k.avif')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return (lat: number, lon: number, out: number[]) => {
    const fx = ((lon + 180) / 360) * info.width - 0.5;
    const fy = ((90 - lat) / 180) * info.height - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    for (let b = 0; b < 3; b++) {
      const g = (x: number, y: number) => data[(y * info.width + x) * 3 + b];
      out[b] = (g(x0, y0) * (1 - tx) + g(x0 + 1, y0) * tx) * (1 - ty) + (g(x0, y0 + 1) * (1 - tx) + g(x0 + 1, y0 + 1) * tx) * ty;
    }
  };
}

/**
 * A north-up view centred on (lat, lon), `widthKm` across, `w` × `h` pixels. The level is the coarsest whose pixel is no
 * bigger than the view's (as a renderer would choose); missing tiles fall back to their parents, then to color-8k.
 */
export async function renderView(
  view: ArchiveView,
  lat0: number,
  lon0: number,
  widthKm: number,
  w: number,
  h: number,
  opts: { level?: number; photoOnly?: boolean; noPhoto?: boolean; match?: number; shore?: boolean } = {},
) {
  const m = view.head.meta.match as (Omit<MatchField, 'data'> & { data: number[] }) | undefined;
  const field: MatchField | null = m && opts.match ? { ...m, data: Float32Array.from(m.data) } : null;
  const mul = [1, 1, 1];
  const bbox = view.head.meta.bbox as number[];
  // Version 2 regions fade over their box; world shards (featherKm 0) end where their pictures end.
  const feathered = ((view.head.meta.featherKm as number | undefined) ?? 3) > 0;
  const c8k = await loadColor8k();
  const mpp = (widthKm * 1000) / w;
  const levels = [...view.levels].sort((p, q) => q.level - p.level);
  const want = opts.level ?? ([...levels].reverse().find((l) => l.pixelM <= mpp * 1.05)?.level ?? levels[0].level);
  const minLevel = Math.min(...levels.map((l) => l.level));
  const out = new Uint8Array(w * h * 3);
  const base = [0, 0, 0];
  const kmLon = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  // Gather the tiles first.
  const need = new Map<string, { face: number; level: number; x: number; y: number }>();
  const spots: { lat: number; lon: number }[] = [];
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const lat = lat0 + ((h / 2 - j - 0.5) * mpp) / 111320;
      const lon = lon0 + ((i + 0.5 - w / 2) * mpp) / (kmLon * 1000);
      spots.push({ lat, lon });
      for (let L = want; L >= minLevel; L--) {
        const t = latLonToTilePixel(lat, lon, L);
        need.set(tileKey(t.face, L, t.x, t.y), { face: t.face, level: L, x: t.x, y: t.y });
        if (view.head.byKey.has(tileKey(t.face, L, t.x, t.y))) break;
      }
    }
  const decoded = new Map<string, Uint8Array | null>();
  await Promise.all([...need.entries()].map(async ([k, t]) => decoded.set(k, await view.tile(t.face, t.level, t.x, t.y))));
  let usedLevel = -1;
  spots.forEach(({ lat, lon }, p) => {
    c8k(lat, lon, base);
    let rgb = opts.photoOnly ? [0, 0, 0] : base;
    for (let L = want; L >= minLevel && !opts.noPhoto; L--) {
      const t = latLonToTilePixel(lat, lon, L);
      const img = decoded.get(tileKey(t.face, L, t.x, t.y));
      if (!img) continue;
      usedLevel = Math.max(usedLevel, L);
      // Bilinear on the tile image (pixel centres at k + 0.5); the gutter keeps every read inside the image.
      const fx = t.px - 0.5;
      const fy = t.py - 0.5;
      const x0 = Math.max(0, Math.min(TILE_PX - 2, Math.floor(fx)));
      const y0 = Math.max(0, Math.min(TILE_PX - 2, Math.floor(fy)));
      const tx = fx - x0;
      const ty = fy - y0;
      const s = [0, 0, 0, 0];
      for (let b = 0; b < 4; b++) {
        const g = (x: number, y: number) => img[(y * TILE_PX + x) * 4 + b];
        s[b] = (g(x0, y0) * (1 - tx) + g(x0 + 1, y0) * tx) * (1 - ty) + (g(x0, y0 + 1) * (1 - tx) + g(x0 + 1, y0 + 1) * tx) * ty;
      }
      // Version 2: alpha > 0 means a picture (its value is the shore distance); the box's feather is worked out here.
      const a = (s[3] > 64 ? 1 : 0) * (feathered ? boxAlpha(bbox, lat, lon) : 1);
      if (opts.shore && s[3] > 64) {
        // Show the photo's water mask: water tinted blue, the shore line yellow.
        const wet = s[3] < 192;
        if (Math.abs(s[3] - 192) < 3) {
          s[0] = 255;
          s[1] = 220;
          s[2] = 0;
        } else if (wet) {
          s[0] = s[0] * 0.4;
          s[1] = s[1] * 0.4 + 40;
          s[2] = s[2] * 0.4 + 150;
        }
      }
      if (field) {
        // The match field, as a renderer would apply it at distance (in linear light).
        fieldAt(field, lat, lon, mul);
        for (let b = 0; b < 3; b++) s[b] = 255 * linearToSrgb(Math.min(1, srgbToLinear(s[b] / 255) * mul[b] ** (opts.match ?? 1)));
      }
      rgb = [0, 1, 2].map((b) => s[b] * a + rgb[b] * (1 - a));
      break;
    }
    out[p * 3] = Math.round(rgb[0]);
    out[p * 3 + 1] = Math.round(rgb[1]);
    out[p * 3 + 2] = Math.round(rgb[2]);
  });
  return { rgb: out, level: usedLevel, mpp };
}

async function luminance(rgb: Uint8Array, w: number, h: number, scale: number) {
  const ow = Math.round(w / scale);
  const oh = Math.round(h / scale);
  const buf = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).resize(ow, oh, { kernel: 'cubic' }).greyscale().raw().toBuffer();
  return { data: Float32Array.from(buf), w: ow, h: oh };
}

/** Normalised cross-correlation of the reference against every offset in a larger picture. */
function bestOffset(big: { data: Float32Array; w: number; h: number }, ref: { data: Float32Array; w: number; h: number }) {
  const n = ref.w * ref.h;
  let rm = 0;
  for (const v of ref.data) rm += v;
  rm /= n;
  let rs = 0;
  const rz = ref.data.map((v) => v - rm);
  for (const v of rz) rs += v * v;
  let best = { score: -2, x: 0, y: 0 };
  for (let oy = 0; oy + ref.h <= big.h; oy++)
    for (let ox = 0; ox + ref.w <= big.w; ox++) {
      let s = 0;
      let s2 = 0;
      let sr = 0;
      for (let y = 0; y < ref.h; y++) {
        const row = (oy + y) * big.w + ox;
        const rrow = y * ref.w;
        for (let x = 0; x < ref.w; x++) {
          const v = big.data[row + x];
          s += v;
          s2 += v * v;
          sr += v * rz[rrow + x];
        }
      }
      const varB = s2 - (s * s) / n;
      const score = sr / Math.sqrt(varB * rs + 1e-9);
      if (score > best.score) best = { score, x: ox, y: oy };
    }
  return best;
}

async function save(rgb: Uint8Array, w: number, h: number, name: string) {
  await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).png().toFile(join(OUT, name));
  return join(OUT, name);
}

function label(text: string, w: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="34"><rect width="100%" height="100%" fill="#111"/><text x="10" y="23" font-family="Helvetica, Arial, sans-serif" font-size="17" fill="#eee">${text}</text></svg>`;
  return Buffer.from(svg);
}

/** Pictures next to each other, each with a caption. */
export async function row(panels: { rgb: Uint8Array | Buffer; w: number; h: number; caption: string }[], name: string) {
  const W = panels.reduce((s, p) => s + p.w, 0) + 12 * (panels.length - 1);
  const H = Math.max(...panels.map((p) => p.h)) + 34;
  const layers: sharp.OverlayOptions[] = [];
  let x = 0;
  for (const p of panels) {
    layers.push({ input: label(p.caption, p.w), top: 0, left: x });
    layers.push({ input: await sharp(p.rgb, { raw: { width: p.w, height: p.h, channels: 3 } }).png().toBuffer(), top: 34, left: x });
    x += p.w + 12;
  }
  await sharp({ create: { width: W, height: H, channels: 3, background: '#111' } }).composite(layers).png().toFile(join(OUT, name));
  return join(OUT, name);
}

export const sideBySide = (a: { rgb: Uint8Array | Buffer; w: number; h: number; caption: string }, b: { rgb: Uint8Array; w: number; h: number; caption: string }, name: string) => row([a, b], name);

async function main(argv: string[]) {
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  mkdirSync(OUT, { recursive: true });
  const view = new ArchiveView(new Uint8Array(readFileSync(get('archive') ?? join(ROOT, 'public/imagery/karnataka-coast.bin'))));
  console.log(`archive: ${view.head.entries.length} tiles; levels ${view.levels.map((l) => `${l.level} (${l.pixelM} m)`).join(', ')}`);
  const refPath = get('reference');
  if (refPath) {
    // Find where the reference sits: render a wider area at a guess of its scale and slide it over, at a few scales.
    const ref = await sharp(refPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const RW = ref.info.width;
    const RH = ref.info.height;
    const guess = { lat: Number(get('lat') ?? 13.81), lon: Number(get('lon') ?? 74.72) };
    const step = 5;
    const refL = await luminance(new Uint8Array(ref.data), RW, RH, step);
    // The reference may be turned a little (a rotated map view): search scale and turn.
    let best = { score: -2, mpp: 0, angle: 0, lat: 0, lon: 0 };
    const kmLon0 = 111.32 * Math.cos((guess.lat * Math.PI) / 180);
    const angles = (get('angles') ?? '-20,-15,-10,-5,0,5,10,14,16,18,20,22,24').split(',').map(Number);
    for (const mpp of (get('mpps') ?? '34,36,38,40,42,44').split(',').map(Number)) {
      const B = Math.round(Math.hypot(RW, RH) * 1.45);
      const big = await renderView(view, guess.lat, guess.lon, (B * mpp) / 1000, B, B);
      for (const angle of angles) {
        const rot = await sharp(big.rgb, { raw: { width: B, height: B, channels: 3 } }).rotate(angle, { background: '#000' }).raw().toBuffer({ resolveWithObject: true });
        const bigL = await luminance(new Uint8Array(rot.data), rot.info.width, rot.info.height, step);
        const o = bestOffset(bigL, refL);
        // The reference centre in the turned picture, turned back, from the big picture's centre.
        const rx = (o.x + refL.w / 2) * step * (rot.info.width / (bigL.w * step)) - rot.info.width / 2;
        const ry = (o.y + refL.h / 2) * step * (rot.info.height / (bigL.h * step)) - rot.info.height / 2;
        const t = (angle * Math.PI) / 180;
        const dx = rx * Math.cos(t) + ry * Math.sin(t);
        const dy = -rx * Math.sin(t) + ry * Math.cos(t);
        const lat = guess.lat - (dy * mpp) / 111320;
        const lon = guess.lon + (dx * mpp) / (kmLon0 * 1000);
        if (o.score > best.score) best = { score: o.score, mpp, angle, lat, lon };
      }
      console.log(`  ${mpp} m a pixel: best so far ${best.score.toFixed(3)} (${best.mpp} m, turned ${best.angle}°)`);
    }
    console.log(`reference: centre ${best.lat.toFixed(4)}, ${best.lon.toFixed(4)}, ${best.mpp} m a pixel, turned ${best.angle}° (match ${best.score.toFixed(3)})`);
    // Our view of the same place, scale and turn.
    const turned = async (lat: number, lon: number, mpp: number, w: number, h: number) => {
      const B = Math.ceil(Math.hypot(w, h)) + 4;
      const r = await renderView(view, lat, lon, (B * mpp) / 1000, B, B);
      const rot = await sharp(r.rgb, { raw: { width: B, height: B, channels: 3 } }).rotate(best.angle, { background: '#000' }).raw().toBuffer({ resolveWithObject: true });
      const left = Math.round((rot.info.width - w) / 2);
      const top = Math.round((rot.info.height - h) / 2);
      const rgb = await sharp(rot.data, { raw: { width: rot.info.width, height: rot.info.height, channels: 3 } }).extract({ left, top, width: w, height: h }).raw().toBuffer();
      return { rgb: new Uint8Array(rgb), level: r.level, mpp };
    };
    const ours = await turned(best.lat, best.lon, best.mpp, RW, RH);
    const file = await sideBySide(
      { rgb: ref.data, w: RW, h: RH, caption: 'Reference (Google satellite)' },
      { rgb: ours.rgb, w: RW, h: RH, caption: `Earth Simulator photo map, level ${ours.level}` },
      'side-by-side-reference.png',
    );
    console.log(`wrote ${file}`);
    // The three footprints, each next to the same patch of the reference (scaled to the same size).
    const kmLon = 111.32 * Math.cos((best.lat * Math.PI) / 180);
    const tb = (best.angle * Math.PI) / 180;
    const spots: [number, number, number][] = [
      [30, RW / 2, RH / 2],
      [10, Number(get('x10') ?? 150), Number(get('y10') ?? 560)],
      [3, Number(get('x3') ?? 70), Number(get('y3') ?? 640)],
    ];
    for (const [km, rx, ry] of spots) {
      const ux = rx - RW / 2;
      const uy = ry - RH / 2;
      const lat = best.lat - ((-ux * Math.sin(tb) + uy * Math.cos(tb)) * best.mpp) / 111320;
      const lon = best.lon + ((ux * Math.cos(tb) + uy * Math.sin(tb)) * best.mpp) / (kmLon * 1000);
      const S = 640;
      const side = (km * 1000) / best.mpp; // reference pixels across
      const left = Math.round(rx - side / 2);
      const top = Math.round(ry - side / 2);
      // (sharp runs extract before extend in one pipeline, so pad first, then cut.)
      const padded = await sharp(ref.data, { raw: { width: RW, height: RH, channels: 3 } })
        .extend({ top: 400, left: 400, bottom: 400, right: 400, background: '#000' })
        .raw()
        .toBuffer();
      const crop = await sharp(padded, { raw: { width: RW + 800, height: RH + 800, channels: 3 } })
        .extract({ left: left + 400, top: top + 400, width: Math.round(side), height: Math.round(side) })
        .resize(S, S, { kernel: 'cubic' })
        .raw()
        .toBuffer();
      const r = await turned(lat, lon, (km * 1000) / S, S, S);
      const f = await sideBySide(
        { rgb: crop, w: S, h: S, caption: `Reference, ${km} km across (${best.mpp} m/px source)` },
        { rgb: r.rgb, w: S, h: S, caption: `Photo map, ${km} km, level ${r.level} (${r.mpp.toFixed(1)} m/px view)` },
        `footprint-${km}km.png`,
      );
      console.log(`wrote ${f} at ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
    }
  }
  // The hand-over at distance: color-8k alone, the photo as stored, and the photo with the match field applied.
  const bbox = view.head.meta.bbox as number[];
  const cLat = (bbox[1] + bbox[3]) / 2;
  const cLon = (bbox[0] + bbox[2]) / 2;
  for (const [name, km, size] of [
    ['blend-at-distance', 260, 520],
    ['blend-region-edge', 70, 640],
  ] as [string, number, number][]) {
    const lat = name === 'blend-region-edge' ? bbox[1] + 0.05 : cLat;
    const lon = name === 'blend-region-edge' ? bbox[2] - 0.05 : cLon;
    const a = await renderView(view, lat, lon, km, size, size, { noPhoto: true });
    const b = await renderView(view, lat, lon, km, size, size);
    const c = await renderView(view, lat, lon, km, size, size, { match: 1 });
    const file = await row(
      [
        { rgb: a.rgb, w: size, h: size, caption: 'color-8k only' },
        { rgb: b.rgb, w: size, h: size, caption: `Photo as stored (level ${b.level})` },
        { rgb: c.rgb, w: size, h: size, caption: 'Photo with the match field' },
      ],
      `${name}.png`,
    );
    console.log(`wrote ${file}`);
  }
  // The photo's water mask over the coast (water blue, shore yellow).
  for (const [name, lat, lon, km] of [
    ['water-mask-baindur-10km', 13.866, 74.63, 10],
    ['water-mask-maravanthe-3km', 13.7256, 74.6475, 3],
  ] as [string, number, number, number][]) {
    const a = await renderView(view, lat, lon, km, 640, 640);
    const b = await renderView(view, lat, lon, km, 640, 640, { shore: true });
    console.log(`wrote ${await row([{ rgb: a.rgb, w: 640, h: 640, caption: `Photo, ${km} km` }, { rgb: b.rgb, w: 640, h: 640, caption: 'Its water mask (alpha): water blue, shore yellow' }], `${name}.png`)}`);
  }
  for (const [name, lat, lon, km] of (get('views') ?? '').split(';').filter(Boolean).map((v) => v.split(',')).map((v) => [v[0], Number(v[1]), Number(v[2]), Number(v[3])] as [string, number, number, number])) {
    const r = await renderView(view, lat, lon, km, 900, 900);
    console.log(`wrote ${await save(r.rgb, 900, 900, `${name}.png`)} (level ${r.level}, ${r.mpp.toFixed(1)} m/px)`);
  }
}

if (process.argv[1]?.endsWith('check.ts')) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
