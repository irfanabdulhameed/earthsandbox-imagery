// The world photo map's job runner (docs/imagery-tiles.md, "World layout"; costs in docs/world-imagery-plan.md).
//
//   npx tsx tools/imagery/world.ts plan                        every land cell and its 10 m tier → world/plan.json
//   npx tsx tools/imagery/world.ts run --all --workers 8       build every shard not built yet (resumable)
//   npx tsx tools/imagery/world.ts run --at 25.7,32.6;19.4,-99.1 --workers 3 --per-orbit 5 --max-fine-blocks 1
//   npx tsx tools/imagery/world.ts run --shards f0-x12-y40,f5-x37-y44
//   npx tsx tools/imagery/world.ts root                        world/root.bin (levels 3–5) and world/match-8k.webp
//   npx tsx tools/imagery/world.ts manifest                    world/manifest.json, the renderer's list of shards
//   npx tsx tools/imagery/world.ts shots --at …                pictures of built shards (reports/shots/photo-map/world-dry-run/)
//   npx tsx tools/imagery/world.ts run --tier t1 --all --slice 3/20 --published <manifest URL> --deadline-minutes 320
//                                                             one of 20 parallel CI jobs (.github/workflows in the builder repo)
//   npx tsx tools/imagery/world.ts site-manifest --tier t1 --dir site   the manifest of a folder about to be published
//
// Output: a folder (IMAGERY_OUT, default tools/imagery/.cache/world-out) or an S3-compatible bucket (IMAGERY_S3_*; see
// store.ts). Work files: IMAGERY_WORK (default tools/imagery/.cache/world-work), one folder per shard, deleted when the
// shard is done. Each shard writes its archive, then a small JSON marker; a shard with a marker is skipped, so the runner
// can be stopped and started again, and a re-run makes the same bytes. Cost log: IMAGERY_PRICE_PER_HOUR (the machine's
// price, dollars an hour) and IMAGERY_PUT_PRICE (dollars per 1000 writes).

import { fork } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { FLAG_ALPHA, FLAG_WATER, readArchiveHead, tileKey, VERSION, writeArchive } from './archive.ts';
import { GUTTER_PX, INNER_PX, TILE_PX } from './cube.ts';
import { encodeTile, SHORE_ALPHA, SHORE_MIN, SHORE_STEPS, srgbToLinear, linearToSrgb } from './finish.ts';
import { buildShard, type ShardStats } from './shard.ts';
import { storeFromEnv, type Store } from './store.ts';
import { BASE_MAX_LEVEL, cellAt, cellSpec, FINE_MAX_LEVEL, loadWorldMaps, parseShardId, ROOT_LEVELS, SHARD_LEVEL, worldSpecs, type ShardSpec } from './world-cells.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
const CACHE = join(ROOT, 'tools/imagery/.cache');
const SELF = new URL(import.meta.url).pathname;

const arg = (argv: string[], k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
// The free plan's T1 (80 m base, no 10 m tier) lives beside the full shards: --tier t1.
let TIER_PREFIX = 'world';
const shardKey = (id: string) => {
  const { face } = parseShardId(id);
  return `${TIER_PREFIX}/shards/f${face}/${id}`;
};
const t0 = Date.now();
const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)} +${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);
const freeGB = (dir: string) => {
  try {
    const s = statfsSync(dir);
    return (s.bavail * s.bsize) / 1e9;
  } catch {
    return NaN;
  }
};

async function loadPlan(store: Store, argv: string[]): Promise<ShardSpec[]> {
  const maps = await loadWorldMaps();
  const at = arg(argv, 'at');
  const ids = arg(argv, 'shards');
  if (at)
    return at.split(';').map((p) => {
      const [lat, lon] = p.split(',').map(Number);
      const c = cellAt(lat, lon);
      const spec = cellSpec(maps, c.face, c.x, c.y);
      if (!spec) throw new Error(`no land in the cell at ${p}`);
      return { ...spec, focus: [lat, lon] as [number, number] };
    });
  if (ids)
    return ids.split(',').map((id) => {
      const c = parseShardId(id);
      const spec = cellSpec(maps, c.face, c.x, c.y);
      if (!spec) throw new Error(`no land in ${id}`);
      return spec;
    });
  const saved = await store.get('world/plan.json');
  if (saved) return (JSON.parse(new TextDecoder().decode(saved)) as { shards: ShardSpec[] }).shards;
  const specs = worldSpecs(maps);
  await store.put('world/plan.json', new TextEncoder().encode(JSON.stringify({ version: 3, shardLevel: SHARD_LEVEL, shards: specs })), 'application/json');
  return specs;
}

async function plan(store: Store, argv: string[]) {
  const specs = await loadPlan(store, argv);
  const fine9 = specs.reduce((s, x) => s + x.fineCount, 0);
  const all9 = specs.length * 64;
  log(`${specs.length} land cells of level ${SHARD_LEVEL}; ${fine9} of their ${all9} level-9 tiles in the 10 m tier (${((100 * fine9) / all9).toFixed(1)}%); snow-clear cells ${specs.filter((s) => s.snow).length}`);
  log(`plan saved in ${store.describe} as world/plan.json`);
}

/** Runs shards in N worker processes; skips shards already built. */
async function run(store: Store, argv: string[]) {
  const specs = await loadPlan(store, argv);
  const workers = Number(arg(argv, 'workers') ?? 2);
  const limit = Number(arg(argv, 'limit') ?? Infinity);
  const price = Number(process.env.IMAGERY_PRICE_PER_HOUR ?? 0);
  const putPrice = Number(process.env.IMAGERY_PUT_PRICE ?? 0.005);
  // CI: --slice i/n takes every n-th shard of the plan (a fixed share for each of n parallel jobs); --published <file or
  // URL> skips shards a site's manifest already lists; --deadline-minutes stops taking new shards in time for the job's
  // limit (the next run carries on).
  const slice = arg(argv, 'slice')?.split('/').map(Number);
  const mine = slice ? specs.filter((_, k) => k % slice[1] === slice[0]) : specs;
  const published = new Set<string>();
  const pub = arg(argv, 'published');
  if (pub) {
    try {
      const text = /^https?:/.test(pub) ? await (await fetch(pub)).text() : readFileSync(pub, 'utf8');
      for (const sh of (JSON.parse(text) as { shards?: { id: string }[] }).shards ?? []) published.add(sh.id);
    } catch {
      log(`no published manifest at ${pub}: building every shard of the slice`);
    }
  }
  const deadline = arg(argv, 'deadline-minutes') ? Date.now() + Number(arg(argv, 'deadline-minutes')) * 60_000 : Infinity;
  const todo: ShardSpec[] = [];
  for (const s of mine) if (!published.has(s.id) && !(await store.exists(`${shardKey(s.id)}.json`))) todo.push(s);
  const queue = todo.slice(0, limit);
  log(`${mine.length} shards asked${slice ? ` (slice ${slice[0]} of ${slice[1]})` : ''}, ${published.size ? `${mine.length - todo.length} already built or published` : `${mine.length - todo.length} already built`}, ${queue.length} to build with ${workers} workers into ${store.describe}`);
  if (!queue.length) return;
  const workArgs = ['worker', '--per-orbit', arg(argv, 'per-orbit') ?? (arg(argv, 'tier') === 't1' ? '3' : '7'), '--quality', arg(argv, 'quality') ?? '74'];
  if (arg(argv, 'tier')) workArgs.push('--tier', arg(argv, 'tier')!);
  if (arg(argv, 'max-fine-blocks')) workArgs.push('--max-fine-blocks', arg(argv, 'max-fine-blocks')!);
  let done = 0;
  let failed = 0;
  let readMB = 0;
  let cpuS = 0;
  let bytes = 0;
  const total = queue.length;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: Math.min(workers, queue.length) }, async (_, w) => {
      const child = fork(SELF, workArgs, { stdio: 'inherit', env: process.env });
      const ask = (spec: ShardSpec) =>
        new Promise<{ ok: boolean; stats?: ShardStats; error?: string }>((resolve) => {
          const onMsg = (m: { ok: boolean; stats?: ShardStats; error?: string }) => {
            child.off('message', onMsg);
            resolve(m);
          };
          child.on('message', onMsg);
          child.send({ spec });
        });
      while (queue.length) {
        if (Date.now() > deadline) {
          log(`worker ${w}: deadline reached, ${queue.length} shards left for the next run`);
          break;
        }
        const spec = queue.shift()!;
        let r = await ask(spec);
        if (!r.ok) r = await ask(spec); // one retry (network trouble)
        if (r.ok && r.stats) {
          done++;
          readMB += r.stats.downloadMB;
          cpuS += r.stats.cpuSeconds;
          bytes += r.stats.bytes;
        } else {
          failed++;
          await store.put(`world/failed/${spec.id}.json`, new TextEncoder().encode(JSON.stringify({ id: spec.id, error: r.error })), 'application/json');
        }
        const hours = (Date.now() - started) / 3.6e6;
        const rate = done / Math.max(hours, 1e-6);
        const left = total - done - failed;
        const cost = hours * price + ((store.stats.puts + done * 2) / 1000) * putPrice;
        log(
          `[${done + failed}/${total}] ${spec.id} ${r.ok ? `done (${((r.stats?.bytes ?? 0) / 1e6).toFixed(1)} MB, ${r.stats?.seconds} s)` : `FAILED: ${r.error}`} | ` +
            `${rate.toFixed(2)} shards/h, ETA ${(left / Math.max(rate, 1e-6)).toFixed(1)} h | read ${(readMB / 1000).toFixed(2)} GB, wrote ${(bytes / 1e9).toFixed(3)} GB, CPU ${(cpuS / 3600).toFixed(2)} h | ` +
            `cost so far $${cost.toFixed(2)}${price ? '' : ' (set IMAGERY_PRICE_PER_HOUR)'} | worker ${w}, free disk ${freeGB(process.env.IMAGERY_WORK ?? CACHE).toFixed(1)} GB`,
        );
      }
      child.kill();
    }),
  );
  log(`run over: ${done} built, ${failed} failed (listed in world/failed/)`);
}

/** A worker: builds the shards the runner sends, one at a time, and stores each archive and then its marker. */
function worker(store: Store, argv: string[]) {
  const work = process.env.IMAGERY_WORK ?? join(CACHE, 'world-work');
  mkdirSync(work, { recursive: true });
  process.on('message', async (m: { spec: ShardSpec }) => {
    try {
      const { archive, stats } = await buildShard(m.spec, {
        work,
        perOrbit: Number(arg(argv, 'per-orbit') ?? 7),
        quality: Number(arg(argv, 'quality') ?? 74),
        maxFineBlocks: arg(argv, 'max-fine-blocks') ? Number(arg(argv, 'max-fine-blocks')) : undefined,
        t1: arg(argv, 'tier') === 't1',
        log,
      });
      await store.put(`${shardKey(m.spec.id)}.bin`, archive);
      await store.put(`${shardKey(m.spec.id)}.json`, new TextEncoder().encode(JSON.stringify(stats)), 'application/json');
      process.send!({ ok: true, stats });
    } catch (err) {
      process.send!({ ok: false, error: err instanceof Error ? `${err.message}` : String(err) });
    }
  });
}

/** The built shards: their markers and archive heads. */
async function builtShards(store: Store, argv: string[]) {
  const specs = await loadPlan(store, argv);
  const out: { spec: ShardSpec; stats: ShardStats; head: ReturnType<typeof readArchiveHead> }[] = [];
  for (const spec of specs) {
    const marker = await store.get(`${shardKey(spec.id)}.json`);
    if (!marker) continue;
    let head = await store.getRange(`${shardKey(spec.id)}.bin`, 0, 65536);
    if (!head) continue;
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const end = dv.getUint32(20, true) + dv.getUint32(24, true);
    if (end > head.length) head = (await store.getRange(`${shardKey(spec.id)}.bin`, 0, end))!;
    out.push({ spec, stats: JSON.parse(new TextDecoder().decode(marker)) as ShardStats, head: readArchiveHead(head) });
  }
  return out;
}

async function manifest(store: Store, argv: string[]) {
  const built = await builtShards(store, argv);
  const rootHead = await store.getRange('world/root.bin', 0, 64);
  const m = {
    version: 3,
    layout: 'cube-sphere cells',
    shardLevel: SHARD_LEVEL,
    tiers: { base: { levels: [SHARD_LEVEL, BASE_MAX_LEVEL], metres: 40 }, fine: { levels: [BASE_MAX_LEVEL + 1, FINE_MAX_LEVEL], metres: 10 } },
    root: rootHead ? { file: 'root.bin', levels: ROOT_LEVELS } : null,
    match: rootHead ? { file: 'match-8k.webp', encoding: 'multiplier = 2^((v − 128) / 32) per channel, linear light; 128 = no change' } : null,
    shards: built.map(({ spec, stats, head }) => ({
      id: spec.id,
      face: spec.face,
      x: spec.x,
      y: spec.y,
      file: `shards/f${spec.face}/${spec.id}.bin`,
      bytes: stats.bytes,
      maxLevel: head.meta.maxLevel,
      land: +spec.land.toFixed(3),
      fine: spec.fine,
      fineBuilt: (head.meta.tiers as { fine: { built: string } }).fine.built,
      lat: spec.lat,
      lon: spec.lon,
    })),
  };
  await store.put('world/manifest.json', new TextEncoder().encode(JSON.stringify(m, null, 1)), 'application/json');
  log(`manifest: ${m.shards.length} shards, ${(m.shards.reduce((s, x) => s + x.bytes, 0) / 1e6).toFixed(1)} MB`);
}

/** Root archive (levels 3–5, each pixel the mean of four below, in linear light) and the world's match field. */
async function root(store: Store, argv: string[]) {
  const built = await builtShards(store, argv);
  // Decoded tiles of the level below, keyed by face/level/x/y.
  let below = new Map<string, Uint8Array>();
  for (const { spec, head } of built) {
    const e = head.byKey.get(tileKey(spec.face, SHARD_LEVEL, spec.x, spec.y));
    if (!e) continue;
    const bytes = await store.getRange(`${shardKey(spec.id)}.bin`, e.offset, e.length);
    if (!bytes) continue;
    below.set(tileKey(spec.face, SHARD_LEVEL, spec.x, spec.y), new Uint8Array(await sharp(bytes).ensureAlpha().raw().toBuffer()));
  }
  const lin = new Float32Array(256);
  for (let v = 0; v < 256; v++) lin[v] = srgbToLinear(v / 255);
  const tiles: { face: number; level: number; x: number; y: number; flags: number; data: Uint8Array }[] = [];
  const levelsOut: { level: number; tiles: number; bytes: number }[] = [];
  for (let level = SHARD_LEVEL - 1; level >= Math.min(...ROOT_LEVELS); level--) {
    const parents = new Set<string>();
    for (const k of below.keys()) {
      const [f, , x, y] = k.split('/').map(Number);
      parents.add(`${f}/${x >> 1}/${y >> 1}`);
    }
    const next = new Map<string, Uint8Array>();
    // A pixel of the level below in face-wide inner coordinates (gx along +a, gy along +b), or null where no tile is.
    const pixel = (f: number, gx: number, gy: number) => {
      const tx = Math.floor(gx / INNER_PX);
      const ty = Math.floor(gy / INNER_PX);
      const img = below.get(tileKey(f, level + 1, tx, ty));
      if (!img) return null;
      const px = GUTTER_PX + gx - tx * INNER_PX;
      const py = GUTTER_PX + (INNER_PX - 1 - (gy - ty * INNER_PX)); // image rows run along −b
      return { img, o: (py * TILE_PX + px) * 4 };
    };
    let count = 0;
    let bytes = 0;
    for (const p of [...parents].sort()) {
      const [f, X, Y] = p.split('/').map(Number);
      const out = new Uint8Array(TILE_PX * TILE_PX * 4);
      let any = false;
      let wet = false;
      for (let j = 0; j < TILE_PX; j++)
        for (let i = 0; i < TILE_PX; i++) {
          // This pixel's footprint: 2 × 2 pixels below, in face-wide coordinates (b grows with tile y; rows run along −b).
          const gx = 2 * (X * INNER_PX + (i - GUTTER_PX));
          const gyB = 2 * (Y * INNER_PX + (INNER_PX - 1 - (j - GUTTER_PX)));
          const acc = [0, 0, 0];
          let sdf = 0;
          let n = 0;
          for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 2; dx++) {
              const q = pixel(f, gx + dx, gyB + dy);
              if (!q || !q.img[q.o + 3]) continue;
              acc[0] += lin[q.img[q.o]];
              acc[1] += lin[q.img[q.o + 1]];
              acc[2] += lin[q.img[q.o + 2]];
              sdf += (q.img[q.o + 3] - SHORE_ALPHA) / SHORE_STEPS;
              n++;
            }
          if (!n) continue;
          const o = (j * TILE_PX + i) * 4;
          for (let b = 0; b < 3; b++) out[o + b] = Math.round(255 * linearToSrgb(acc[b] / n));
          // The shore distance in this level's (twice as large) pixels.
          const a = Math.max(SHORE_MIN, Math.min(255, Math.round(SHORE_ALPHA + (SHORE_STEPS * (sdf / n)) / 2)));
          out[o + 3] = a;
          if (a < SHORE_ALPHA) wet = true;
          any = true;
        }
      if (!any) continue;
      next.set(tileKey(f, level, X, Y), out);
      if (ROOT_LEVELS.includes(level)) {
        const data = await encodeTile(out, false, Number(arg(argv, 'quality') ?? 74));
        tiles.push({ face: f, level, x: X, y: Y, flags: FLAG_ALPHA | (wet ? FLAG_WATER : 0), data });
        count++;
        bytes += data.length;
      }
    }
    levelsOut.push({ level, tiles: count, bytes });
    below = next;
    log(`root level ${level}: ${count} tiles`);
  }
  const meta = {
    version: VERSION,
    layout: 3,
    name: 'root',
    format: 'webp',
    mime: 'image/webp',
    tileSize: TILE_PX,
    gutter: GUTTER_PX,
    inner: INNER_PX,
    minLevel: Math.min(...ROOT_LEVELS),
    maxLevel: Math.max(...ROOT_LEVELS),
    colourSpace: 'srgb',
    alpha: 'straight',
    featherKm: 0,
    shore: { alpha: SHORE_ALPHA, stepsPerPixel: SHORE_STEPS, min: SHORE_MIN, max: 255, none: 0, landPositive: true },
    levels: levelsOut.sort((p, q) => p.level - q.level),
    source: 'Contains modified Copernicus Sentinel data (Sentinel-2 L2A, collection 1), read from Earth Search on AWS',
    shards: built.length,
    tool: 'tools/imagery/world.ts root',
  };
  await store.put('world/root.bin', writeArchive(meta, tiles));
  // The match field: every shard's, on color-8k's grid (128 = no change; 2^((v − 128) / 32) per channel).
  const W = 8192;
  const H = 4096;
  const img = new Uint8Array(W * H * 3).fill(128);
  for (const { head } of built) {
    const m = head.meta.match as { col0: number; row0: number; cols: number; rows: number; data: number[] } | null;
    if (!m) continue;
    for (let r = 0; r < m.rows; r++)
      for (let c = 0; c < m.cols; c++)
        for (let b = 0; b < 3; b++) {
          const v = m.data[(r * m.cols + c) * 3 + b];
          if (v === 1) continue;
          img[((m.row0 + r) * W + ((m.col0 + c) % W)) * 3 + b] = Math.max(1, Math.min(255, Math.round(128 + 32 * Math.log2(v))));
        }
  }
  await store.put('world/match-8k.webp', new Uint8Array(await sharp(img, { raw: { width: W, height: H, channels: 3 } }).webp({ lossless: true, effort: 4 }).toBuffer()), 'image/webp');
  log(`root: ${tiles.length} tiles from ${built.length} shards; match-8k.webp written`);
}

/**
 * The publish job's manifest: every shard archive found under <dir>/<tier prefix>/shards/, read from its own head, written
 * to <dir>/<tier prefix>/manifest.json (the list the renderer reads and the next run skips).
 */
function siteManifest(argv: string[]) {
  const dir = arg(argv, 'dir');
  if (!dir) throw new Error('site-manifest: --dir <site folder> is required');
  const root = join(dir, TIER_PREFIX, 'shards');
  const shards: Record<string, unknown>[] = [];
  for (const f of readdirSync(root).filter((n) => /^f\d$/.test(n)).sort())
    for (const name of readdirSync(join(root, f)).filter((n) => n.endsWith('.bin')).sort()) {
      const bytes = readFileSync(join(root, f, name));
      const head = readArchiveHead(new Uint8Array(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, 1 << 20)));
      const cell = head.meta.cell as { face: number; x: number; y: number };
      shards.push({ id: name.replace(/\.bin$/, ''), face: cell.face, x: cell.x, y: cell.y, file: `shards/${f}/${name}`, bytes: bytes.length, maxLevel: head.meta.maxLevel });
    }
  const m = { version: 3, tier: TIER_PREFIX === 'world/t1' ? 'T1' : 'full', shardLevel: SHARD_LEVEL, shards };
  writeFileSync(join(dir, TIER_PREFIX, 'manifest.json'), JSON.stringify(m));
  log(`site manifest: ${shards.length} shards in ${join(dir, TIER_PREFIX, 'manifest.json')}`);
}

/** Pictures of the built shards (and the root around them) for checking: reports/shots/photo-map/world-dry-run/. */
async function shots(store: Store, argv: string[]) {
  const { ArchiveView, renderView, row } = await import('./check.ts');
  const out = join(ROOT, 'reports/shots/photo-map/world-dry-run');
  mkdirSync(out, { recursive: true });
  const built = await builtShards(store, argv);
  const rootBytes = await store.get('world/root.bin');
  const rootView = rootBytes ? new ArchiveView(rootBytes) : null;
  const S = 560;
  for (const { spec } of built) {
    const view = new ArchiveView((await store.get(`${shardKey(spec.id)}.bin`))!);
    const [fLat, fLon] = spec.focus ?? [spec.lat, spec.lon];
    const panels = [];
    const cell = await renderView(view, spec.lat, spec.lon, 190, S, S);
    panels.push({ rgb: cell.rgb, w: S, h: S, caption: `${spec.id}: the cell, 190 km (level ${cell.level})` });
    if (rootView) {
      const r = await renderView(rootView, spec.lat, spec.lon, 900, S, S);
      panels.push({ rgb: r.rgb, w: S, h: S, caption: `root.bin, 900 km (level ${r.level})` });
    }
    for (const km of [20, 3]) {
      const v = await renderView(view, fLat, fLon, km, S, S);
      panels.push({ rgb: v.rgb, w: S, h: S, caption: `${km} km at ${fLat}, ${fLon} (level ${v.level})` });
    }
    const wv = await renderView(view, fLat, fLon, 20, S, S, { shore: true });
    panels.push({ rgb: wv.rgb, w: S, h: S, caption: 'its water mask: water blue, shore yellow' });
    const tag = TIER_PREFIX === 'world' ? '' : 't1-';
    log(`wrote ${await row(panels.slice(0, 3), `world-dry-run/${tag}${spec.id}-a.png`)}`);
    log(`wrote ${await row(panels.slice(3), `world-dry-run/${tag}${spec.id}-b.png`)}`);
    for (const extra of (arg(argv, 'views') ?? '').split(';').filter(Boolean)) {
      const [name, lat, lon, km] = extra.split(',');
      if (!insideAny(spec, Number(lat), Number(lon))) continue;
      const v = await renderView(view, Number(lat), Number(lon), Number(km), S, S);
      log(`wrote ${await row([{ rgb: v.rgb, w: S, h: S, caption: `${name}: ${km} km (level ${v.level})` }], `world-dry-run/${spec.id}-${name}.png`)}`);
    }
  }
}
const insideAny = (spec: ShardSpec, lat: number, lon: number) => {
  const c = cellAt(lat, lon);
  return c.face === spec.face && c.x === spec.x && c.y === spec.y;
};

async function main(argv: string[]) {
  if (arg(argv, 'tier') === 't1') TIER_PREFIX = 'world/t1';
  const store = storeFromEnv(process.env, join(CACHE, 'world-out'));
  const cmd = argv[0];
  if (cmd === 'worker') return worker(store, argv);
  if (cmd === 'plan') return plan(store, argv);
  if (cmd === 'run') return run(store, argv);
  if (cmd === 'root') return root(store, argv);
  if (cmd === 'manifest') return manifest(store, argv);
  if (cmd === 'shots') return shots(store, argv);
  if (cmd === 'site-manifest') return siteManifest(argv);
  console.log('usage: world.ts plan | run [--all | --shards ids | --at lat,lon;…] [--workers N] [--per-orbit 7] [--max-fine-blocks K] [--limit M] | root | manifest');
}

if (process.argv[1] && SELF.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { shardKey };
