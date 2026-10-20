// The free plan's T2: which places get the 10 m tier, as much as the free host holds (docs/world-imagery-plan.md).
//
// Every level-9 tile of the full plan's 10 m pick (people ≥ 5 a km², or land within 10 km of the sea) is scored by the
// people living on it (people-4320.bin, GHS-POP 2025), doubled where it touches the coast (water-8k); the highest scores are
// taken until the estimated archive bytes reach the budget. Picked tiles are grouped by level-8 block (one archive each,
// at most four level-9 tiles, a few MB), and blocks are dealt to Cloudflare Pages projects in score order, each project
// kept under its byte budget and well under Pages' 20,000 files. Deterministic: the same maps give the same plan, and the
// plan is kept in the repository (t2-plan.json.gz) so a block never moves between projects from one run to the next.

import { dirToFace, latLonToDir, pixelMetres, INNER_PX } from './cube.ts';
import { FINE_PICK_LEVEL, fineTiles, isIceSheet, NORTH_LIMIT, SOUTH_LIMIT, tilePoints, type ShardSpec, type WorldMaps } from './world-cells.ts';

/** Estimated archive bytes per level-9 tile at levels 10–11 (Karnataka 0.6 MB, a city's 1 MB, a desert's 0.4 MB). */
export const EST_MB_PER_TILE = 0.75;
/** Archives a Pages project takes at most (its limit is 20,000 files, a few go to the site's own pages and lists). */
export const MAX_FILES_PER_PROJECT = 18000;

export interface T2Block {
  id: string;
  face: number;
  x: number;
  y: number;
  /** Picked level-9 tiles, [x, y]. */
  tiles: [number, number][];
  /** Index into the plan's projects. */
  project: number;
  /** The block's best tile's score (people, doubled on the coast). */
  score: number;
  lat: number;
  lon: number;
}

export interface T2Plan {
  version: 3;
  tier: 'T2';
  cellLevel: 8;
  levels: [10, 11];
  budgetGB: number;
  projectGB: number;
  estMBPerTile: number;
  /** Project suffixes: the Pages project of index p is `<main project>-<projects[p]>`. */
  projects: string[];
  tiles: number;
  people: number;
  blocks: T2Block[];
}

/** The T2 plan for a budget (GB) over the land cells of the full plan. */
export function planT2(maps: WorldMaps, specs: ShardSpec[], budgetGB = 10, projectGB = 5): T2Plan {
  interface Scored {
    face: number;
    x: number;
    y: number;
    people: number;
    score: number;
  }
  const scored: Scored[] = [];
  for (const spec of specs)
    for (const t of fineTiles(spec)) {
      const pts = tilePoints(spec.face, FINE_PICK_LEVEL, t.x, t.y, 9).filter((p) => p.lat >= SOUTH_LIMIT && p.lat <= NORTH_LIMIT && !isIceSheet(p.lat, p.lon));
      if (!pts.length) continue;
      const mid = dirToFace(latLonToDir(pts[40 % pts.length].lat, pts[40 % pts.length].lon));
      const side = (pixelMetres(FINE_PICK_LEVEL, mid.a, mid.b) * INNER_PX) / 1000;
      const area = side * side;
      let density = 0;
      let coastal = false;
      for (const p of pts) {
        const c = maps.coastKm(p.lat, p.lon);
        if (c < 0.5) density += maps.peoplePerKm2(p.lat, p.lon);
        if (c < 0.5 && c > -10) coastal = true;
      }
      const people = (density / 81) * area;
      if (people < 1) continue;
      scored.push({ face: spec.face, x: t.x, y: t.y, people, score: people * (coastal ? 2 : 1) });
    }
  scored.sort((p, q) => q.score - p.score || p.face - q.face || p.y - q.y || p.x - q.x);
  const n = Math.min(scored.length, Math.floor((budgetGB * 1000) / EST_MB_PER_TILE));
  const picked = scored.slice(0, n);
  // Blocks, in the order of their best tile.
  const blocks = new Map<string, T2Block>();
  const order: string[] = [];
  for (const t of picked) {
    const bx = t.x >> 1;
    const by = t.y >> 1;
    const id = `t2-f${t.face}-x${bx}-y${by}`;
    let b = blocks.get(id);
    if (!b) {
      const c = tilePoints(t.face, 8, bx, by, 1)[0];
      b = { id, face: t.face, x: bx, y: by, tiles: [], project: 0, score: Math.round(t.score), lat: +c.lat.toFixed(4), lon: +c.lon.toFixed(4) };
      blocks.set(id, b);
      order.push(id);
    }
    b.tiles.push([t.x, t.y]);
  }
  // Projects in score order, as few as the budget allows and evenly filled, each under its bytes and files.
  const totalMB = picked.length * EST_MB_PER_TILE;
  const nProjects = Math.max(1, Math.ceil(totalMB / (projectGB * 1000)), Math.ceil(order.length / MAX_FILES_PER_PROJECT));
  const capMB = (totalMB / nProjects) * 1.02;
  const capFiles = Math.min(MAX_FILES_PER_PROJECT, Math.ceil((order.length / nProjects) * 1.02));
  let project = 0;
  let mb = 0;
  let files = 0;
  for (const id of order) {
    const b = blocks.get(id)!;
    b.tiles.sort((p, q) => p[1] - q[1] || p[0] - q[0]);
    const est = b.tiles.length * EST_MB_PER_TILE;
    if (files > 0 && project < nProjects - 1 && (mb + est > capMB || files + 1 > capFiles)) {
      project++;
      mb = 0;
      files = 0;
    }
    b.project = project;
    mb += est;
    files++;
  }
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  return {
    version: 3,
    tier: 'T2',
    cellLevel: 8,
    levels: [10, 11],
    budgetGB,
    projectGB,
    estMBPerTile: EST_MB_PER_TILE,
    projects: Array.from({ length: project + 1 }, (_, k) => `t2${letters[k]}`),
    tiles: picked.length,
    people: Math.round(picked.reduce((s, t) => s + t.people, 0)),
    blocks: order.map((id) => blocks.get(id)!),
  };
}
