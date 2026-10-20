// The fine people map's file format (public/earth/people-4320.bin, made by tools/prep-popgrid.ts from GHS-POP 2025).
//
//   header (24 bytes, little-endian): 'POP1', width (u32), height (u32), smallest and largest people per cell on the
//                                     scale (f32, f32), countries (u32)
//   body (deflate-raw, level 9):      people[width × height] (u8), country[width × height] (u8), then
//                                     coast[width × height] (u8): cells from the sea (0 = the cell holds sea), 255 where
//                                     nobody lives or 255 or more cells inland
//
// Cells run from the north row down, each row from 180° W east; a cell is 360/width degrees. People per cell are on a
// log scale: 0 is nobody, q = 1..255 is pMin·(pMax/pMin)^((q−1)/254), so a step is about 7% (each cell within about ±3.6%;
// sums over many cells far closer). Country is the index in src/sim/data/countries-2025.json, or 255 where nobody lives.
// Coast counts cells (8-neighbour steps) to the nearest cell holding sea (ETOPO1 below 0 m and joined to the open ocean,
// as tools/hydro-lib.ts finds it), for the people a tsunami can reach.
// No DOM or Node here: the worker and the globe inflate the body themselves (DecompressionStream), the tools with zlib.

export const POPGRID_FORMAT = {
  file: 'people-4320.bin',
  width: 4320,
  height: 2160,
  headerBytes: 24,
  magic: 'POP1',
  /** People per cell at q = 1 and q = 255. */
  pMin: 0.1,
  pMax: 2e7,
  countries: 237,
} as const;

export interface PopGridHeader {
  width: number;
  height: number;
  pMin: number;
  pMax: number;
  countries: number;
}

export interface PopGridData extends PopGridHeader {
  /** Log-scaled people per cell (0 = nobody). */
  people: Uint8Array;
  /** Country index per cell (countries-2025.json order), 255 where nobody lives. */
  country: Uint8Array;
  /** Cells to the nearest sea (0: the cell holds sea joined to the open ocean), 255 where nobody lives. */
  coast: Uint8Array;
  /** People per cell for each value of `people`. */
  lut: Float64Array;
}

/** People per cell for each byte value. */
export function popLut(pMin: number, pMax: number): Float64Array {
  const lut = new Float64Array(256);
  const l0 = Math.log(pMin);
  const s = (Math.log(pMax) - l0) / 254;
  for (let q = 1; q < 256; q++) lut[q] = Math.exp(l0 + (q - 1) * s);
  return lut;
}

/** The byte for each cell's people (for the prep tool). */
export function quantisePeople(people: Float64Array, pMin: number = POPGRID_FORMAT.pMin, pMax: number = POPGRID_FORMAT.pMax): Uint8Array {
  const out = new Uint8Array(people.length);
  const l0 = Math.log(pMin);
  const s = (Math.log(pMax) - l0) / 254;
  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    if (!(p > 0)) continue;
    const x = (Math.log(p) - l0) / s;
    if (x < -0.5) continue;
    out[i] = Math.min(255, Math.max(1, 1 + Math.round(x)));
  }
  return out;
}

export function encodeHeader(h: PopGridHeader = POPGRID_FORMAT): Uint8Array {
  const b = new Uint8Array(POPGRID_FORMAT.headerBytes);
  const v = new DataView(b.buffer);
  for (let i = 0; i < 4; i++) b[i] = POPGRID_FORMAT.magic.charCodeAt(i);
  v.setUint32(4, h.width, true);
  v.setUint32(8, h.height, true);
  v.setFloat32(12, h.pMin, true);
  v.setFloat32(16, h.pMax, true);
  v.setUint32(20, h.countries, true);
  return b;
}

/** Reads the header of a file as stored (throws on anything else). The deflated body starts at headerBytes. */
export function readHeader(file: Uint8Array): PopGridHeader {
  if (file.length < POPGRID_FORMAT.headerBytes) throw new Error('people map: file too short');
  const magic = String.fromCharCode(file[0], file[1], file[2], file[3]);
  if (magic !== POPGRID_FORMAT.magic) throw new Error(`people map: expected ${POPGRID_FORMAT.magic}, got ${magic}`);
  const v = new DataView(file.buffer, file.byteOffset, POPGRID_FORMAT.headerBytes);
  return { width: v.getUint32(4, true), height: v.getUint32(8, true), pMin: v.getFloat32(12, true), pMax: v.getFloat32(16, true), countries: v.getUint32(20, true) };
}

/** The map from its header and inflated body. */
export function popGridFromBody(h: PopGridHeader, body: Uint8Array): PopGridData {
  const n = h.width * h.height;
  if (body.length !== 3 * n) throw new Error(`people map: body is ${body.length} bytes, expected ${3 * n}`);
  return { ...h, people: body.subarray(0, n), country: body.subarray(n, 2 * n), coast: body.subarray(2 * n, 3 * n), lut: popLut(h.pMin, h.pMax) };
}

/** The map from a header followed by the inflated body (one buffer). */
export function decodePopGrid(bytes: Uint8Array): PopGridData {
  return popGridFromBody(readHeader(bytes), bytes.subarray(POPGRID_FORMAT.headerBytes));
}
