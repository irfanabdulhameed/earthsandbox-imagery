# Earth imagery

Builds a world photo map as tile archives on the cube-sphere a 3D globe draws, and publishes them as a static site on
Cloudflare Pages. Only the build lives here; no game code.

| Tier | What | Source | Levels |
|---|---|---|---|
| T0 | the whole globe at 500 m | NASA Blue Marble Next Generation, July 2004 | 2–5 |
| T1 | all land between 56° S and 84° N at 80 m | Copernicus Sentinel-2 L2A, the 8× overviews of its cloud-optimised GeoTIFFs | 6–8 |
| T2 | 10 m for the most-populated places (later) | Copernicus Sentinel-2 L2A at full resolution | 10–11 |

Sentinel-2 is read anonymously from the public Earth Search catalogue on AWS (Element 84) with HTTP range requests; no
account or key is needed for the data.

## Running it

- `.github/workflows/t1.yml`: 20 parallel jobs, each building every 20th shard until its time budget runs out, then one
  job publishes everything in a single Pages deployment. Run it again until nothing is left (it skips what the live
  site already lists; a schedule repeats it every 6 hours).
- `.github/workflows/t0.yml`: builds T0 in one job and publishes it with the rest of the site.
- `.github/workflows/t2.yml`: the 10 m tier for the places in `tools/imagery/t2-plan.json.gz` (13,333 level-9 tiles of the
  biggest cities and the populated coasts, 6,931 block archives, about 10 GB) over two more Pages projects
  (`earthsandbox-imagery-t2a`, `-t2b`, created on demand), with its index on the main project. Best run after T1.
  Deployments of the main project take turns, so T0, T1 and T2 never undo each other.
- Secrets: `CLOUDFLARE_API_TOKEN` (permission: Account → Cloudflare Pages → Edit) and `CLOUDFLARE_ACCOUNT_ID`.
  Optional repository variable `PAGES_PROJECT` (default `earthsandbox-imagery`).

Locally (Node 22):

```sh
npm ci
npx tsx tools/imagery/world.ts run --tier t1 --at "25.70,32.64" --workers 2   # one shard, into tools/imagery/.cache/world-out
npx tsx tools/imagery/t0.ts                                                     # T0, about 20 minutes
```

## Output

```
world/t0/index.json, world/t0/f<face>/t0-f<face>-x<x>-y<y>.bin     T0, one archive per level-2 cell
world/t1/manifest.json, world/t1/shards/f<face>/f<face>-x<x>-y<y>.bin   T1, one archive per level-6 cell
world/t1/match-8k.webp                                              T1's world-wide colour match
world/t2/index.json  (main project; `bases` names the T2 projects)  T2, one archive per level-8 block
world/t2/list.json, world/t2/f<face>/t2-f<face>-x<x>-y<y>.bin  (each T2 project)
```

`match-8k.webp` (8192 × 4096, lossless; per channel a linear multiplier 2^((v − 128) / 32), 128 for none) holds every T1
shard's colour match to the Blue Marble colour, carried a little past the edge of the Sentinel-2 cover and faded out
over 150 km. A reader applies its inverse to T0 close up, so T0 takes T1's colour where the two meet. The publish job
writes it, with `manifest.json`, from every shard on the site.

Each archive is a small binary index followed by 512 × 512 WebP tiles (an 8-pixel gutter; alpha is the signed distance to
the shore). Cloudflare Pages answers HTTP Range requests with the whole file, so a reader fetches an archive whole (they
are 0.05–3 MB) and reads tiles from it.

## Credits and licences

- Contains modified Copernicus Sentinel data (2025–2026).
- NASA Earth Observatory, Blue Marble Next Generation (Reto Stöckli, NASA Goddard Space Flight Center): public domain.
- `public/earth/people-4320.bin`: summed from GHS-POP R2023A (European Commission, Joint Research Centre), CC BY 4.0.
- `public/earth/water-8k.webp`: the coast distance from NOAA ETOPO1 and Blue Marble (public domain).
- `public/earth/color-8k.avif`: NASA Blue Marble Next Generation, resized (public domain).
