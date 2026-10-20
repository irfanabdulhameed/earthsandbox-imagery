// The world-wide colour match a tier publishes beside its listing (match-8k.webp; docs/imagery-tiles.md "Root and match" and
// "The free tiers"): every shard's own match field (linear multipliers that take the Sentinel-2 colour to color-8k's) put on
// color-8k's 8192 × 4096 grid as v = 128 + 32·log2(m) per channel (128: no change).
//
// The renderer applies its inverse to T0 (Blue Marble, color-8k's own colour) close up, so T0 takes the Sentinel-2 colour
// where it meets T1. For that to leave no seam at the edge of the Sentinel-2 cover, the field also runs on past it: the
// nearest values carried outward (a push-pull fill over a coarse grid) and faded to no change over FADE_KM.

export interface ShardMatch {
  col0: number;
  row0: number;
  cols: number;
  rows: number;
  data: number[];
}

export const MATCH_W = 8192;
export const MATCH_H = 4096;
/** How far past the edge of the Sentinel-2 cover the match fades out. */
export const FADE_KM = 150;
const COARSE = 4; // coarse cells of 4 × 4 color-8k pixels (about 20 km) for the fill outward
/** Within this many color-8k pixels of the cover (about 30 km) a pixel takes its nearest measured pixel's value, so a
 *  valley or a coast running out of the cover keeps its own correction; farther out the smooth fill takes over. */
const NEAR_PX = 6;

/** The RGB bytes of match-8k from the shards' fields (cells left at exactly 1 carry no measurement and are skipped). */
export function worldMatch(fields: ShardMatch[]): Uint8Array {
  const W = MATCH_W;
  const H = MATCH_H;
  const out = new Uint8Array(W * H * 3).fill(128);
  const known = new Uint8Array(W * H);
  // Exact values where a shard measured them.
  for (const m of fields)
    for (let r = 0; r < m.rows; r++)
      for (let c = 0; c < m.cols; c++) {
        const k = (r * m.cols + c) * 3;
        if (m.data[k] === 1 && m.data[k + 1] === 1 && m.data[k + 2] === 1) continue;
        const row = m.row0 + r;
        if (row < 0 || row >= H) continue;
        const col = (((m.col0 + c) % W) + W) % W;
        const o = row * W + col;
        known[o] = 1;
        for (let b = 0; b < 3; b++) out[o * 3 + b] = Math.max(1, Math.min(255, Math.round(128 + 32 * Math.log2(Math.max(1e-4, m.data[k + b])))));
      }
  // The fill outward, on coarse cells: their known means, then a push-pull pyramid for the cells with none.
  const cw = W / COARSE;
  const ch = H / COARSE;
  const levels: { w: number; h: number; v: Float32Array; n: Float32Array }[] = [];
  const v0 = new Float32Array(cw * ch * 3);
  const n0 = new Float32Array(cw * ch);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const o = y * W + x;
      if (!known[o]) continue;
      const k = Math.floor(y / COARSE) * cw + Math.floor(x / COARSE);
      for (let b = 0; b < 3; b++) v0[k * 3 + b] += (out[o * 3 + b] - 128) / 32;
      n0[k]++;
    }
  levels.push({ w: cw, h: ch, v: v0, n: n0 });
  while (levels[levels.length - 1].w > 1) {
    const p = levels[levels.length - 1];
    const w = Math.ceil(p.w / 2);
    const h = Math.ceil(p.h / 2);
    const v = new Float32Array(w * h * 3);
    const n = new Float32Array(w * h);
    for (let y = 0; y < p.h; y++)
      for (let x = 0; x < p.w; x++) {
        const i = y * p.w + x;
        if (!p.n[i]) continue;
        const k = (y >> 1) * w + (x >> 1);
        for (let b = 0; b < 3; b++) v[k * 3 + b] += p.v[i * 3 + b];
        n[k] += p.n[i];
      }
    levels.push({ w, h, v, n });
  }
  // Pull: each level's cells without data take their parent's mean (the means stay sums over counts).
  const mean = (L: (typeof levels)[number], i: number, b: number) => L.v[i * 3 + b] / L.n[i];
  const filled = levels.map((L) => new Float32Array(L.w * L.h * 3));
  for (let li = levels.length - 1; li >= 0; li--) {
    const L = levels[li];
    for (let y = 0; y < L.h; y++)
      for (let x = 0; x < L.w; x++) {
        const i = y * L.w + x;
        for (let b = 0; b < 3; b++)
          filled[li][i * 3 + b] = L.n[i] ? mean(L, i, b) : li + 1 < levels.length ? filled[li + 1][((y >> 1) * levels[li + 1].w + (x >> 1)) * 3 + b] : 0;
      }
  }
  // Distance (coarse cells, scaled east-west by latitude) to the nearest cell with data, for the fade.
  const dist = new Float32Array(cw * ch).fill(Infinity);
  const queue: number[] = [];
  for (let i = 0; i < cw * ch; i++)
    if (n0[i]) {
      dist[i] = 0;
      queue.push(i);
    }
  if (!queue.length) return out;
  const cellKm = (40030 / cw) * 1; // a coarse cell's north-south size, km
  const reach = FADE_KM / cellKm + 2;
  // Two chamfer passes over a window around the data (the fade only reaches a few cells).
  for (let pass = 0; pass < 2; pass++) {
    const ys = pass ? [...Array(ch).keys()].reverse() : [...Array(ch).keys()];
    for (const y of ys) {
      const lat = 90 - ((y + 0.5) / ch) * 180;
      const ew = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
      const xs = pass ? [...Array(cw).keys()].reverse() : [...Array(cw).keys()];
      for (const x of xs) {
        const i = y * cw + x;
        let d = dist[i];
        const xl = (x - 1 + cw) % cw;
        const xr = (x + 1) % cw;
        const yn = pass ? y + 1 : y - 1;
        const xp = pass ? xr : xl;
        d = Math.min(d, dist[y * cw + xp] + ew);
        if (yn >= 0 && yn < ch) {
          d = Math.min(d, dist[yn * cw + x] + 1, dist[yn * cw + xl] + Math.hypot(1, ew), dist[yn * cw + xr] + Math.hypot(1, ew));
        }
        dist[i] = Math.min(d, reach * 4);
      }
    }
  }
  const smooth = (t: number) => {
    const u = Math.min(1, Math.max(0, t));
    return u * u * (3 - 2 * u);
  };
  // Nearest measured pixel within NEAR_PX (a breadth-first spread from every measured pixel, wrapping east-west).
  const near = new Int32Array(W * H).fill(-1);
  const nearD = new Float32Array(W * H).fill(Infinity);
  let front: number[] = [];
  for (let o = 0; o < W * H; o++)
    if (known[o]) {
      near[o] = o;
      nearD[o] = 0;
      front.push(o);
    }
  for (let step = 0; step < NEAR_PX && front.length; step++) {
    const next: number[] = [];
    for (const o of front) {
      const x = o % W;
      const y = (o - x) / W;
      const src = near[o];
      const sx = src % W;
      const sy = (src - sx) / W;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        const xx = (x + dx + W) % W;
        const q = yy * W + xx;
        if (known[q]) continue;
        let ddx = Math.abs(xx - sx);
        ddx = Math.min(ddx, W - ddx);
        const d = Math.hypot(ddx, yy - sy);
        if (d < nearD[q]) {
          if (nearD[q] === Infinity) next.push(q);
          nearD[q] = d;
          near[q] = src;
        }
      }
    }
    front = next;
  }
  // Unknown pixels near the data: the nearest measured value close by, the filled coarse value (bilinear) farther out,
  // faded with the distance.
  for (let y = 0; y < H; y++) {
    const cy = (y + 0.5) / COARSE - 0.5;
    const y0 = Math.max(0, Math.min(ch - 1, Math.floor(cy)));
    const y1 = Math.min(ch - 1, y0 + 1);
    const ty = Math.min(1, Math.max(0, cy - y0));
    for (let x = 0; x < W; x++) {
      const o = y * W + x;
      if (known[o]) continue;
      const cx = (x + 0.5) / COARSE - 0.5;
      const x0 = ((Math.floor(cx) % cw) + cw) % cw;
      const x1 = (x0 + 1) % cw;
      const tx = cx - Math.floor(cx);
      const d = (dist[y0 * cw + x0] * (1 - tx) + dist[y0 * cw + x1] * tx) * (1 - ty) + (dist[y1 * cw + x0] * (1 - tx) + dist[y1 * cw + x1] * tx) * ty;
      if (!(d * cellKm < FADE_KM)) continue;
      const f = 1 - smooth((d * cellKm) / FADE_KM);
      const wn = near[o] >= 0 ? 1 - smooth((nearD[o] - NEAR_PX / 2) / (NEAR_PX / 2)) : 0;
      for (let b = 0; b < 3; b++) {
        const g = (xx: number, yy: number) => filled[0][(yy * cw + xx) * 3 + b];
        let v = (g(x0, y0) * (1 - tx) + g(x1, y0) * tx) * (1 - ty) + (g(x0, y1) * (1 - tx) + g(x1, y1) * tx) * ty;
        if (wn > 0) v = wn * ((out[near[o] * 3 + b] - 128) / 32) + (1 - wn) * v;
        out[o * 3 + b] = Math.max(1, Math.min(255, Math.round(128 + 32 * v * f)));
      }
    }
  }
  return out;
}
