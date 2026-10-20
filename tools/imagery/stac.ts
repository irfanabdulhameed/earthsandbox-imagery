// Finds Sentinel-2 L2A scenes in the public Earth Search catalogue (Element 84, on AWS; no account or key) and keeps
// the answer in the cache, so a re-run uses the same scene list.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STAC_URL = 'https://earth-search.aws.element84.com/v1/search';
export const COLLECTION = 'sentinel-2-c1-l2a';

export interface Scene {
  id: string;
  /** MGRS tile, e.g. 43PDR. */
  tile: string;
  datetime: string;
  /** The acquisition: every MGRS tile cut from one pass of one satellite shares it. */
  datatake: string;
  orbit: number;
  epsg: number;
  cloud: number;
  /** Easting and northing of the top-left corner (metres) and the 10 m grid size. */
  e0: number;
  n0: number;
  size: number;
  /** reflectance = DN × scale + offset */
  scale: number;
  offset: number;
  href: { red: string; green: string; blue: string; scl: string; aot: string };
}

interface StacFeature {
  id: string;
  properties: Record<string, unknown>;
  assets: Record<string, { href: string; 'proj:transform'?: number[]; 'proj:shape'?: number[]; 'raster:bands'?: { scale?: number; offset?: number }[] }>;
}

async function post(body: unknown): Promise<{ features: StacFeature[]; links?: { rel: string; href: string; body?: Record<string, unknown>; method?: string; merge?: boolean }[] }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(STAC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`STAC search: HTTP ${res.status}`);
      return (await res.json()) as { features: StacFeature[] };
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

/** All scenes over the box in the date ranges with a scene cloud cover under maxCloud, cached by query. */
export async function searchScenes(cacheDir: string, bbox: number[], ranges: [string, string][], maxCloud: number): Promise<Scene[]> {
  const key = `stac-${bbox.map((v) => v.toFixed(4)).join('_')}-${ranges.map((r) => r.join('_')).join('-')}-${maxCloud}.json`;
  const file = join(cacheDir, key);
  let features: StacFeature[];
  if (existsSync(file)) features = JSON.parse(readFileSync(file, 'utf8')) as StacFeature[];
  else {
    features = [];
    for (const [from, to] of ranges) {
      let body: Record<string, unknown> | null = {
        collections: [COLLECTION],
        bbox,
        datetime: `${from}T00:00:00Z/${to}T23:59:59Z`,
        limit: 200,
        query: { 'eo:cloud_cover': { lt: maxCloud } },
      };
      for (let page = 0; page < 50 && body; page++) {
        const res = await post(body);
        features.push(...res.features);
        const next = res.links?.find((l) => l.rel === 'next');
        // The catalogue's next link carries only the page token and asks for it to be merged into the query.
        body = next?.body && res.features.length ? (next.merge === false ? next.body : { ...body, ...next.body }) : null;
      }
    }
    writeFileSync(file, JSON.stringify(features));
  }
  const scenes = features.map(toScene).filter((s): s is Scene => s !== null);
  // One copy of each tile of each acquisition (the catalogue can hold a reprocessed twin): keep the newest baseline.
  const byKey = new Map<string, Scene>();
  for (const s of scenes.sort((a, b) => (a.id < b.id ? -1 : 1))) byKey.set(`${s.tile}|${s.datatake}`, s);
  return [...byKey.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function toScene(f: StacFeature): Scene | null {
  const p = f.properties;
  const red = f.assets.red;
  if (!red || !f.assets.scl || !f.assets.green || !f.assets.blue) return null;
  const t = red['proj:transform'];
  const shape = red['proj:shape'];
  if (!t || !shape || t[0] !== 10 || t[4] !== -10) return null;
  const uri = String(p['s2:product_uri'] ?? '');
  const orbit = Number(/_R(\d{3})_/.exec(uri)?.[1] ?? 0);
  const band = red['raster:bands']?.[0] ?? {};
  return {
    id: f.id,
    tile: `${p['mgrs:utm_zone']}${p['mgrs:latitude_band']}${p['mgrs:grid_square']}`,
    datetime: String(p.datetime),
    datatake: String(p['s2:datatake_id'] ?? `${String(p.datetime).slice(0, 19)}-${orbit}`),
    orbit,
    epsg: Number(p['proj:epsg']),
    cloud: Number(p['eo:cloud_cover'] ?? 100),
    e0: t[2],
    n0: t[5],
    size: shape[0],
    scale: band.scale ?? 0.0001,
    offset: band.offset ?? 0,
    href: { red: red.href, green: f.assets.green.href, blue: f.assets.blue.href, scl: f.assets.scl.href, aot: f.assets.aot?.href ?? '' },
  };
}
