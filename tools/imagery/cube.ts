// The game's cube-sphere, as the photo tiles use it. This is a port of the face table and mapping in src/view/tiles.ts
// (FACES, cubeToSphere, FACE_GLSL) and of the latitude and longitude convention in src/view/geo.ts, without three.js.
// tests/imagery-tiles.test.ts checks the port against both files, so the photo lands exactly where the terrain draws it.
// The tile and pixel layout is the contract in docs/imagery-tiles.md.

export type Vec3 = [number, number, number];

/** Face normal, u axis and v axis, in the order of FACES in src/view/tiles.ts. */
export const FACES: [Vec3, Vec3, Vec3][] = [
  [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
  [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
  [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
];

/** Every tile image: T × T pixels, an inner N × N block covering the tile exactly and a G-pixel gutter on each side. */
export const TILE_PX = 512;
export const GUTTER_PX = 8;
export const INNER_PX = TILE_PX - 2 * GUTTER_PX;
export const R_KM = 6371;

const DEG = Math.PI / 180;
const Q = Math.PI / 4;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Face coordinates (a, b) in [-1, 1]² to a unit direction: normalize(n + u·tan(aπ/4) + v·tan(bπ/4)). */
export function faceToDir(face: number, a: number, b: number): Vec3 {
  const [n, u, v] = FACES[face];
  const ta = Math.tan(a * Q);
  const tb = Math.tan(b * Q);
  const x = n[0] + u[0] * ta + v[0] * tb;
  const y = n[1] + u[1] * ta + v[1] * tb;
  const z = n[2] + u[2] * ta + v[2] * tb;
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

/** The face a direction falls on (the largest n·d; ties go to the lower face number) and its face coordinates. */
export function dirToFace(d: Vec3): { face: number; a: number; b: number } {
  let face = 0;
  let best = -Infinity;
  for (let f = 0; f < 6; f++) {
    const k = dot(d, FACES[f][0]);
    if (k > best) {
      best = k;
      face = f;
    }
  }
  return { face, ...dirOnFace(d, face) };
}

/** Face coordinates of a direction on a given face, also past the face's edges (for gutters); valid while n·d > 0. */
export function dirOnFace(d: Vec3, face: number): { a: number; b: number } {
  const [n, u, v] = FACES[face];
  const k = dot(d, n);
  return { a: Math.atan(dot(d, u) / k) / Q, b: Math.atan(dot(d, v) / k) / Q };
}

/** As src/view/geo.ts latLonToVec3 with radius 1. */
export function latLonToDir(latDeg: number, lonDeg: number): Vec3 {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  return [Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)];
}

/** As src/view/geo.ts vec3ToLatLon. */
export function dirToLatLon(d: Vec3): { lat: number; lon: number } {
  const r = Math.hypot(d[0], d[1], d[2]);
  return { lat: Math.asin(Math.max(-1, Math.min(1, d[1] / r))) / DEG, lon: Math.atan2(-d[2], d[0]) / DEG };
}

/** Size of a tile in face units at a level. */
export const tileSpan = (level: number) => 2 / 2 ** level;

/** The face-coordinate box of a tile: a0..a1, b0..b1. */
export function tileBounds(level: number, x: number, y: number) {
  const s = tileSpan(level);
  const a0 = -1 + x * s;
  const b0 = -1 + y * s;
  return { s, a0, a1: a0 + s, b0, b1: b0 + s };
}

/** Face coordinates of the centre of image pixel (i, j) of a tile (column i along +a, row j along −b, gutter included). */
export function pixelCentre(level: number, x: number, y: number, i: number, j: number): { a: number; b: number } {
  const { s, a0, b1 } = tileBounds(level, x, y);
  return { a: a0 + ((i + 0.5 - GUTTER_PX) * s) / INNER_PX, b: b1 - ((j + 0.5 - GUTTER_PX) * s) / INNER_PX };
}

/** Image pixel coordinates (continuous; pixel centres at k + 0.5) of face coordinates within a tile's image. */
export function facePixel(level: number, x: number, y: number, a: number, b: number): { px: number; py: number } {
  const { s, a0, b1 } = tileBounds(level, x, y);
  return { px: GUTTER_PX + ((a - a0) / s) * INNER_PX, py: GUTTER_PX + ((b1 - b) / s) * INNER_PX };
}

/** The tile that holds face coordinates (a, b) at a level (a = 1 or b = 1 goes to the last tile). */
export function tileAt(level: number, a: number, b: number): { x: number; y: number } {
  const n = 2 ** level;
  const s = tileSpan(level);
  return { x: Math.min(n - 1, Math.max(0, Math.floor((a + 1) / s))), y: Math.min(n - 1, Math.max(0, Math.floor((b + 1) / s))) };
}

export interface TilePixel {
  face: number;
  level: number;
  x: number;
  y: number;
  /** Continuous image coordinates of the point, gutter included: pixel (i, j) spans [i, i+1) × [j, j+1). */
  px: number;
  py: number;
}

/** Latitude and longitude (degrees) to its tile and position inside the tile's image at a level. */
export function latLonToTilePixel(latDeg: number, lonDeg: number, level: number): TilePixel {
  const { face, a, b } = dirToFace(latLonToDir(latDeg, lonDeg));
  const { x, y } = tileAt(level, a, b);
  return { face, level, x, y, ...facePixel(level, x, y, a, b) };
}

/** The inverse: a position in a tile's image to latitude and longitude. */
export function tilePixelToLatLon(t: TilePixel): { lat: number; lon: number } {
  const { s, a0, b1 } = tileBounds(t.level, t.x, t.y);
  const a = a0 + ((t.px - GUTTER_PX) * s) / INNER_PX;
  const b = b1 - ((t.py - GUTTER_PX) * s) / INNER_PX;
  return dirToLatLon(faceToDir(t.face, a, b));
}

/** Ground size of one pixel (metres, the geometric mean of its two sides) at face coordinates (a, b) and a level. */
export function pixelMetres(level: number, a: number, b: number): number {
  const s = tileSpan(level) / INNER_PX;
  // Arc lengths of a small step along a and along b, on the face plane mapped to the sphere.
  const step = (da: number, db: number) => {
    const p = faceToDir(0, a, b);
    const q = faceToDir(0, a + da, b + db);
    return Math.acos(Math.min(1, dot(p, q))) * R_KM * 1000;
  };
  const e = 1e-6;
  return (Math.sqrt(step(e, 0) * step(0, e)) / e) * s;
}

/** Morton (Z-order) code of (x, y) with x in the even bits; x, y below 2^16. */
export function morton(x: number, y: number): number {
  let m = 0;
  for (let k = 0; k < 16; k++) m += (((x >> k) & 1) * 2 ** (2 * k)) + (((y >> k) & 1) * 2 ** (2 * k + 1));
  return m;
}
