// The free plan's T0: NASA Blue Marble Next Generation (July 2004, without topography shading: the same picture as
// color-8k) at its full 500 m, cut into the game's cube-sphere tiles (levels 2–5) and packed one archive per level-2 cell
// (96 archives, a few MB each), in the version 2 archive format. Public domain; NASA's credit is already on the Credits page.
//
//   npx tsx tools/imagery/t0.ts            → IMAGERY_OUT (default tools/imagery/.cache/world-out)/world/t0/…
//
// The eight 21600 × 21600 panels are fetched one at a time (35–80 MB each), decoded in memory, used and deleted, so the
// disk never holds more than one panel. Tiles that straddle panels wait in memory until their last panel is done.
// Alpha is the version 2 shore, from the game's own water picture (water-8k), so T0's coast is the game's coast.

import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
// (Each panel is deleted as soon as it is decoded.)
import { join } from 'node:path';
import sharp from 'sharp';
import { FLAG_ALPHA, FLAG_WATER, VERSION, writeArchive } from './archive.ts';
import { dirToFace, dirToLatLon, faceToDir, GUTTER_PX, INNER_PX, latLonToDir, pixelMetres, TILE_PX, tileBounds } from './cube.ts';
import { SHORE_ALPHA, SHORE_MIN, SHORE_STEPS } from './finish.ts';
import { storeFromEnv } from './store.ts';
import { loadWorldMaps } from './world-cells.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
const CACHE = join(ROOT, 'tools/imagery/.cache');
const URL_BASE = 'https://eoimages.gsfc.nasa.gov/images/imagerecords/74000/74092/world.200407.3x21600x21600';
const PANEL = 21600;
const LEVELS = [2, 3, 4, 5];
const CELL_LEVEL = 2;
const t0 = Date.now();
const log = (s: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);

/** Panel of a point: column A–D from 180° W in 90° steps, row 1 north of the equator, 2 south. */
const panelOf = (lat: number, lon: number) => `${'ABCD'[Math.min(3, Math.max(0, Math.floor((lon + 180) / 90)))]}${lat >= 0 ? 1 : 2}`;

interface Pending {
  face: number;
  level: number;
  x: number;
  y: number;
  rgba: Uint8Array;
  need: Set<string>;
}

/** Latitude and longitude of every pixel centre of a tile (from a 33 × 33 control grid). */
function tileLatLon(face: number, level: number, x: number, y: number) {
  const { s, a0, b1 } = tileBounds(level, x, y);
  const STEP = 16;
  const K = TILE_PX / STEP + 1;
  const cd: [number, number, number][] = [];
  for (let j = 0; j < K; j++)
    for (let i = 0; i < K; i++) cd.push(faceToDir(face, a0 + ((i * STEP - GUTTER_PX) * s) / INNER_PX, b1 - ((j * STEP - GUTTER_PX) * s) / INNER_PX));
  const lat = new Float64Array(TILE_PX * TILE_PX);
  const lon = new Float64Array(TILE_PX * TILE_PX);
  for (let j = 0; j < TILE_PX; j++) {
    const gy = (j + 0.5) / STEP;
    const ky = Math.min(K - 2, Math.floor(gy));
    const ty = gy - ky;
    for (let i = 0; i < TILE_PX; i++) {
      const gx = (i + 0.5) / STEP;
      const kx = Math.min(K - 2, Math.floor(gx));
      const tx = gx - kx;
      const k = ky * K + kx;
      // Interpolate the direction (not the angles: no trouble at the antimeridian or the poles).
      const d = [0, 1, 2].map((c) => (cd[k][c] * (1 - tx) + cd[k + 1][c] * tx) * (1 - ty) + (cd[k + K][c] * (1 - tx) + cd[k + K + 1][c] * tx) * ty) as [number, number, number];
      const ll = dirToLatLon(d);
      lat[j * TILE_PX + i] = ll.lat;
      lon[j * TILE_PX + i] = ll.lon;
    }
  }
  return { lat, lon };
}

async function main() {
  const store = storeFromEnv(process.env, join(CACHE, 'world-out'));
  const maps = await loadWorldMaps();
  const work = join(CACHE, 't0');
  mkdirSync(work, { recursive: true });
  // Every tile of levels 2–5 on all six faces (the whole globe: Blue Marble has the sea too).
  const pending = new Map<string, Pending>();
  const done = new Map<string, { face: number; level: number; x: number; y: number; flags: number; data: Uint8Array }>();
  for (const level of LEVELS) {
    const n = 2 ** level;
    for (let face = 0; face < 6; face++)
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          // Every panel its pixels fall in, from a 65 × 65 grid over it (gutter included); a sliver a panel edge cuts
          // between grid points is filled from its neighbours when the tile is finished.
          const need = new Set<string>();
          const { s, a0, b1 } = tileBounds(level, x, y);
          for (let j = 0; j <= 64; j++)
            for (let i = 0; i <= 64; i++) {
              const ll = dirToLatLon(faceToDir(face, a0 + ((i * 8 - GUTTER_PX) * s) / INNER_PX, b1 - ((j * 8 - GUTTER_PX) * s) / INNER_PX));
              need.add(panelOf(ll.lat, ll.lon));
            }
          pending.set(`${face}/${level}/${x}/${y}`, { face, level, x, y, rgba: new Uint8Array(0), need });
        }
  }
  log(`${pending.size} tiles to make from 8 panels`);
  let downloaded = 0;
  const order = ['A1', 'B1', 'C1', 'D1', 'A2', 'B2', 'C2', 'D2'];
  // The next panel downloads while this one is drawn (at most two on disk).
  const fetchPanel = async (panel: string) => {
    // NASA's server drops long downloads now and then: resume with Range requests until the whole panel is in.
    const file = join(work, `${panel}.jpg`);
    const url = `${URL_BASE}.${panel}.jpg`;
    const parts: Uint8Array[] = [];
    let have = 0;
    let total = Infinity;
    for (let attempt = 0; have < total; attempt++) {
      if (attempt > 20) throw new Error(`Blue Marble ${panel}: gave up after ${attempt} tries`);
      try {
        const res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {} });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const len = Number(res.headers.get('content-length') ?? NaN);
        if (!have) total = len;
        const reader = res.body!.getReader();
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          parts.push(value);
          have += value.length;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    writeFileSync(file, Buffer.concat(parts));
    return file;
  };
  let next = fetchPanel(order[0]);
  for (const [pi, panel] of order.entries()) {
    const file = await next;
    if (pi + 1 < order.length) next = fetchPanel(order[pi + 1]);
    downloaded += statSync(file).size;
    const lon0 = -180 + 90 * 'ABCD'.indexOf(panel[0]);
    const lat0 = panel[1] === '1' ? 90 : 0;
    // The panel and its halvings (for levels 4, 3, 2: each pixel then covers about one tile pixel).
    const full = await sharp(file, { limitInputPixels: false }).removeAlpha().raw().toBuffer();
    rmSync(file);
    const mips: { w: number; data: Buffer }[] = [{ w: PANEL, data: full }];
    for (let k = 1; k <= 3; k++) {
      const w = PANEL >> k;
      mips.push({ w, data: await sharp(full, { raw: { width: PANEL, height: PANEL, channels: 3 }, limitInputPixels: false }).resize(w, w, { kernel: 'cubic' }).raw().toBuffer() });
    }
    let made = 0;
    const encoding: Promise<void>[] = [];
    for (const [key, t] of pending) {
      if (!t.need.has(panel)) continue;
      const mip = mips[Math.min(3, 5 - t.level)];
      const W = mip.w;
      const scale = W / 90;
      if (!t.rgba.length) t.rgba = new Uint8Array(TILE_PX * TILE_PX * 4);
      const ll = tileLatLon(t.face, t.level, t.x, t.y);
      for (let i = 0; i < TILE_PX * TILE_PX; i++) {
        const lat = ll.lat[i];
        const lon = ll.lon[i];
        if (panelOf(lat, lon) !== panel) continue;
        const fx = Math.min(W - 1.001, Math.max(0, (lon - lon0) * scale - 0.5));
        const fy = Math.min(W - 1.001, Math.max(0, (lat0 - lat) * scale - 0.5));
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = fx - x0;
        const ty = fy - y0;
        const o = (y0 * W + x0) * 3;
        const o2 = o + W * 3;
        for (let b = 0; b < 3; b++)
          t.rgba[i * 4 + b] = Math.round((mip.data[o + b] * (1 - tx) + mip.data[o + 3 + b] * tx) * (1 - ty) + (mip.data[o2 + b] * (1 - tx) + mip.data[o2 + 3 + b] * tx) * ty);
        t.rgba[i * 4 + 3] = 1; // filled (the shore is written when the tile is done)
      }
      t.need.delete(panel);
      if (t.need.size) continue;
      // Done: the shore from the game's water picture, then encode.
      const c = (TILE_PX / 2) * TILE_PX + TILE_PX / 2;
      const mid = dirToFace(latLonToDir(ll.lat[c], ll.lon[c]));
      const pm = pixelMetres(t.level, mid.a, mid.b);
      let wet = false;
      for (let i = 0; i < TILE_PX * TILE_PX; i++) {
        const dLand = -maps.coastKm(ll.lat[i], ll.lon[i]) * 1000;
        const a = Math.max(SHORE_MIN, Math.min(255, Math.round(SHORE_ALPHA + (SHORE_STEPS * dLand) / pm)));
        t.rgba[i * 4 + 3] = a;
        if (a < SHORE_ALPHA) wet = true;
      }
      // Fill any pixel no panel reached (a sliver between grid points) from its nearest filled neighbour on the row.
      for (let j = 0; j < TILE_PX; j++)
        for (let i = 0; i < TILE_PX; i++) {
          const o = (j * TILE_PX + i) * 4;
          if (t.rgba[o] || t.rgba[o + 1] || t.rgba[o + 2]) continue;
          for (let d = 1; d < 24; d++) {
            const q = i + d < TILE_PX ? o + d * 4 : -1;
            const r = i - d >= 0 ? o - d * 4 : -1;
            const src = q >= 0 && (t.rgba[q] || t.rgba[q + 1] || t.rgba[q + 2]) ? q : r >= 0 && (t.rgba[r] || t.rgba[r + 1] || t.rgba[r + 2]) ? r : -1;
            if (src < 0) continue;
            t.rgba[o] = t.rgba[src];
            t.rgba[o + 1] = t.rgba[src + 1];
            t.rgba[o + 2] = t.rgba[src + 2];
            break;
          }
        }
      const rgba = t.rgba;
      const flags = FLAG_ALPHA | (wet ? FLAG_WATER : 0);
      encoding.push(
        sharp(rgba, { raw: { width: TILE_PX, height: TILE_PX, channels: 4 } })
          .webp({ quality: 80, effort: 4, smartSubsample: true, alphaQuality: 100 })
          .toBuffer()
          .then((b) => {
            done.set(key, { face: t.face, level: t.level, x: t.x, y: t.y, flags, data: new Uint8Array(b) });
          }),
      );
      if (encoding.length >= 12) await Promise.all(encoding.splice(0));
      t.rgba = new Uint8Array(0);
      pending.delete(key);
      made++;
    }
    await Promise.all(encoding);
    log(`panel ${panel}: ${made} tiles finished, ${pending.size} waiting; ${(downloaded / 1e6).toFixed(0)} MB fetched so far`);
  }
  rmSync(work, { recursive: true, force: true });
  // One archive per level-2 cell.
  const cells = new Map<string, typeof done extends Map<string, infer V> ? V[] : never>();
  for (const t of done.values()) {
    const sh = t.level - CELL_LEVEL;
    const k = `${t.face}/${t.x >> sh}/${t.y >> sh}`;
    cells.set(k, [...(cells.get(k) ?? []), t]);
  }
  let bytes = 0;
  const list: { id: string; file: string; bytes: number }[] = [];
  for (const [k, tiles] of [...cells.entries()].sort()) {
    const [face, x, y] = k.split('/').map(Number);
    const id = `t0-f${face}-x${x}-y${y}`;
    const levels = LEVELS.map((level) => ({ level, tiles: tiles.filter((t) => t.level === level).length, bytes: tiles.filter((t) => t.level === level).reduce((s, t) => s + t.data.length, 0) }));
    const meta = {
      version: VERSION,
      layout: 3,
      tier: 'T0',
      name: id,
      cell: { face, x, y, level: CELL_LEVEL },
      format: 'webp',
      mime: 'image/webp',
      tileSize: TILE_PX,
      gutter: GUTTER_PX,
      inner: INNER_PX,
      minLevel: Math.min(...LEVELS),
      maxLevel: Math.max(...LEVELS),
      colourSpace: 'srgb',
      alpha: 'straight',
      featherKm: 0,
      shore: { alpha: SHORE_ALPHA, stepsPerPixel: SHORE_STEPS, min: SHORE_MIN, max: 255, none: 0, landPositive: true, source: 'the game water picture (water-8k)' },
      levels,
      bbox: [-180, -90, 180, 90],
      source: 'NASA Blue Marble Next Generation, July 2004, without topography shading, 500 m (world.200407.3x21600x21600)',
      tool: 'tools/imagery/t0.ts',
    };
    const archive = writeArchive(meta, tiles);
    const file = `world/t0/f${face}/${id}.bin`;
    await store.put(file, archive);
    bytes += archive.length;
    list.push({ id, file: file.replace(/^world\//, ''), bytes: archive.length });
  }
  await store.put('world/t0/index.json', new TextEncoder().encode(JSON.stringify({ version: 3, tier: 'T0', cellLevel: CELL_LEVEL, levels: LEVELS, archives: list }, null, 1)), 'application/json');
  log(`T0: ${done.size} tiles in ${list.length} archives, ${(bytes / 1e6).toFixed(1)} MB; fetched ${(downloaded / 1e6).toFixed(0)} MB into ${store.describe}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
