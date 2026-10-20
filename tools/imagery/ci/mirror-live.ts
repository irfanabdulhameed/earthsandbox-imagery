// Copies every file the live site already publishes into a local folder, so one Cloudflare Pages deployment can hold the
// whole site again (a Pages deployment replaces the site: whatever it leaves out disappears). Files already in the
// folder (this run's new or rebuilt ones) are kept as they are. The list comes from the site's own manifests:
// world/t0/index.json (T0) and world/t1/manifest.json (T1). A first run, with nothing published, copies nothing.
//
//   npx tsx tools/imagery/ci/mirror-live.ts <site folder> <site URL>
//
// It stops with an error if any listed file cannot be fetched, so a deployment never drops published files.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [dir, base] = process.argv.slice(2);
if (!dir || !base) throw new Error('usage: mirror-live.ts <site folder> <site URL>');
const url = (p: string) => `${base.replace(/\/$/, '')}/${p}`;

async function json(path: string): Promise<Record<string, unknown> | null> {
  // Network trouble is retried, then fails the job: deploying without the live files would delete them.
  let res: Response | null = null;
  for (let attempt = 0; !res; attempt++) {
    try {
      res = await fetch(url(path));
    } catch (err) {
      if (attempt >= 5) throw new Error(`${path}: ${String(err)} (is the site live? the workflow skips this step before the first deployment)`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const text = await res.text();
  // Not JSON (a site without a 404 page answers missing paths with its index page): nothing published there. A list
  // that looks like JSON but does not parse stops the job.
  if (!text.trimStart().startsWith('{')) return null;
  return JSON.parse(text) as Record<string, unknown>;
}

const files: string[] = [];
const t0 = await json('world/t0/index.json');
if (t0) {
  files.push('world/t0/index.json');
  for (const a of (t0.archives as { file: string }[]) ?? []) files.push(`world/${a.file}`);
}
const t1 = await json('world/t1/manifest.json');
if (t1) for (const s of (t1.shards as { file: string }[]) ?? []) files.push(`world/t1/${s.file}`);
const missing = files.filter((f) => !existsSync(join(dir, f)));
console.log(`live site lists ${files.length} files; ${missing.length} to fetch (${files.length - missing.length} rebuilt in this run)`);
let done = 0;
let bytes = 0;
const fetchOne = async (f: string) => {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url(f));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), buf);
      bytes += buf.length;
      done++;
      return;
    } catch (err) {
      if (attempt >= 5) throw new Error(`${f}: ${String(err)}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
};
const queue = [...missing];
await Promise.all(
  Array.from({ length: 16 }, async () => {
    while (queue.length) await fetchOne(queue.shift()!);
  }),
);
console.log(`fetched ${done} files, ${(bytes / 1e6).toFixed(1)} MB`);
