// Makes one photo map archive for a latitude and longitude box from raw Sentinel-2 L2A scenes:
//
//   npm run imagery -- --bbox 74.3,13.3,75.2,14.3 --name karnataka-coast
//
// Options:
//   --bbox w,s,e,n       the box in degrees (required; keep it inside one 6° UTM zone)
//   --name NAME          archive name: public/imagery/NAME.bin (default "region")
//   --years 2025,2026    years whose dry season to use
//   --season 01-01,03-31 the dry-season window (month-day,month-day); pick one outside the local rainy season
//   --per-orbit 7        dates per orbit for the median
//   --max-level 11       finest level (11 = about 10 m); --min-level 3 the coarsest (the first that beats color-8k)
//   --quality 74         WebP quality
//   --out DIR            output folder (default public/imagery)
//   --stage composite    stop after the composite (for checking it)
//   --bench 12           also keep 12 raw finest tiles in the cache, for tools/imagery/bench.ts (WebP or AVIF)
//
// The download cache (catalogue answers, the plan, the finished composite and the water votes, never whole scenes) is in
// tools/imagery/.cache/,
// which git ignores; the tool prints how much space it takes. Delete the folder to start over.
// The same options and the same catalogue answer give the same archive, byte for byte.
// The contract for the archive is docs/imagery-tiles.md.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stats } from './cog.ts';
import { buildComposite, makeGrid, planComposite, type Plan } from './composite.ts';
import { searchScenes } from './stac.ts';
import { epsgOf, toUtm, zoneOf } from './utm.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
export const CACHE = join(ROOT, 'tools/imagery/.cache');

export interface Options {
  bbox: number[];
  name: string;
  years: number[];
  season: [string, string];
  perOrbit: number;
  minLevel: number;
  maxLevel: number;
  quality: number;
  out: string;
  stage: string;
  /** Keep this many raw finest-level tiles in the cache for tools/imagery/bench.ts. */
  bench: number;
}

export function parseArgs(argv: string[]): Options {
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const bbox = (get('bbox') ?? '').split(',').map(Number);
  if (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v)) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3])
    throw new Error('--bbox west,south,east,north is required (degrees)');
  const season = (get('season') ?? '01-01,03-31').split(',') as [string, string];
  return {
    bbox,
    name: get('name') ?? 'region',
    years: (get('years') ?? '2025,2026').split(',').map(Number),
    season,
    perOrbit: Number(get('per-orbit') ?? 7),
    minLevel: Number(get('min-level') ?? 3),
    maxLevel: Number(get('max-level') ?? 11),
    quality: Number(get('quality') ?? 74),
    out: get('out') ?? join(ROOT, 'public/imagery'),
    stage: get('stage') ?? 'all',
    bench: Number(get('bench') ?? 0),
  };
}

export function diskUse(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    total += st.isDirectory() ? diskUse(p) : st.size;
  }
  return total;
}

const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;

export async function main(argv: string[]) {
  const t0 = Date.now();
  const opts = parseArgs(argv);
  const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)} s] ${s}`);
  mkdirSync(CACHE, { recursive: true });
  const [w, s, e, n] = opts.bbox;
  const zone = zoneOf((s + n) / 2, (w + e) / 2);
  log(`box ${opts.bbox.join(', ')}; UTM zone ${zone.zone}${zone.south ? 'S' : 'N'}`);

  const ranges = opts.years.map((y) => [`${y}-${opts.season[0]}`, `${y}-${opts.season[1]}`] as [string, string]);
  const all = await searchScenes(CACHE, opts.bbox, ranges, 40);
  const scenes = all.filter((x) => x.epsg === epsgOf(zone));
  log(`${scenes.length} scenes in the catalogue (${all.length - scenes.length} in other UTM zones left out)`);
  if (!scenes.length) throw new Error('no scenes found');

  // Align strips to the scene that covers the box's middle.
  const c = toUtm((s + n) / 2, (w + e) / 2, zone);
  const mid = scenes.find((x) => c.e >= x.e0 && c.e < x.e0 + x.size * 10 && c.n <= x.n0 && c.n > x.n0 - x.size * 10) ?? scenes[0];
  const grid = makeGrid(opts.bbox, zone, 1500, mid.n0);
  log(`grid ${grid.w} × ${grid.h} pixels of 10 m (${((grid.w * grid.h) / 1e6).toFixed(0)} Mpx)`);

  // The plan (scores, chosen dates, gains, blend weights) is cached: it costs a pass over every candidate's overviews.
  const planFile = join(
    CACHE,
    `plan-${createHash('sha256').update(JSON.stringify({ grid, ids: scenes.map((x) => x.id), perOrbit: opts.perOrbit, v: 1 })).digest('hex').slice(0, 12)}.json`,
  );
  let plan: Plan;
  if (existsSync(planFile)) {
    const raw = JSON.parse(readFileSync(planFile, 'utf8')) as Omit<Plan, 'weights'> & { weights: Record<number, string> };
    const weights: Record<number, Float32Array> = {};
    for (const [o, b64] of Object.entries(raw.weights)) {
      const buf = Buffer.from(b64, 'base64');
      weights[Number(o)] = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    }
    plan = { ...raw, weights };
    log(`plan from the cache: ${plan.takes.length} dates over ${plan.orbits.length} orbits`);
  } else {
    plan = await planComposite(grid, scenes, opts.bbox, { perOrbit: opts.perOrbit, minOrbitShare: 0.03, blendKm: 12, log });
    const weights = Object.fromEntries(Object.entries(plan.weights).map(([o, w]) => [o, Buffer.from(w.buffer, w.byteOffset, w.byteLength).toString('base64')]));
    writeFileSync(planFile, JSON.stringify({ ...plan, weights }));
  }
  const key = createHash('sha256')
    .update(JSON.stringify({ grid, takes: plan.takes.map((t) => t.scenes.map((x) => x.id)), gains: plan.gains, v: 2 }))
    .digest('hex')
    .slice(0, 12);
  log(`plan ${key}: ${plan.takes.length} dates over ${plan.orbits.length} orbits; downloaded so far ${mb(stats.bytes)} in ${stats.requests} requests`);
  const comp = await buildComposite(plan, CACHE, key, log);
  const q = [0, 0, 0];
  for (const v of comp.quality) q[v]++;
  log(`composite ready: ${((100 * q[2]) / comp.quality.length).toFixed(3)}% of pixels clear, ${((100 * q[1]) / comp.quality.length).toFixed(3)}% only from cloudy dates, ${((100 * q[0]) / comp.quality.length).toFixed(3)}% no picture`);
  log(`downloaded ${mb(stats.bytes)} in ${stats.requests} requests (${stats.retries} retries); cache ${mb(diskUse(CACHE))}`);
  if (opts.stage === 'composite') return { opts, plan, comp, key };

  const { finish } = await import('./finish.ts');
  await finish(opts, plan, comp, key, log);
  log(`done; downloaded ${mb(stats.bytes)} in total; cache ${mb(diskUse(CACHE))} in tools/imagery/.cache`);
  return { opts, plan, comp, key };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
