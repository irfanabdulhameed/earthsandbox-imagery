// UTM on the WGS84 ellipsoid (the Sentinel-2 grids), by Krüger's series to third order: about a millimetre within
// 3000 km of the central meridian, far below a 10 m pixel.

const A = 6378137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const E0 = 500000;
const N = F / (2 - F);
const AA = (A / (1 + N)) * (1 + (N * N) / 4 + (N ** 4) / 64);
const ALPHA = [N / 2 - (2 * N * N) / 3 + (5 * N ** 3) / 16, (13 * N * N) / 48 - (3 * N ** 3) / 5, (61 * N ** 3) / 240];
const BETA = [N / 2 - (2 * N * N) / 3 + (37 * N ** 3) / 96, (N * N) / 48 + N ** 3 / 15, (17 * N ** 3) / 480];
const DELTA = [2 * N - (2 * N * N) / 3 - 2 * N ** 3, (7 * N * N) / 3 - (8 * N ** 3) / 5, (56 * N ** 3) / 15];
const C = (2 * Math.sqrt(N)) / (1 + N);
const DEG = Math.PI / 180;

export interface Zone {
  zone: number;
  south: boolean;
}

export const zoneOf = (lat: number, lon: number): Zone => ({ zone: Math.floor((lon + 180) / 6) + 1, south: lat < 0 });
export const epsgOf = (z: Zone) => (z.south ? 32700 : 32600) + z.zone;
const centralMeridian = (z: Zone) => (z.zone - 1) * 6 - 180 + 3;

/** Latitude and longitude (degrees) to easting and northing (metres) in a zone. */
export function toUtm(lat: number, lon: number, z: Zone): { e: number; n: number } {
  const phi = lat * DEG;
  const dl = (lon - centralMeridian(z)) * DEG;
  const s = Math.sin(phi);
  const t = Math.sinh(Math.atanh(s) - C * Math.atanh(C * s));
  const xi = Math.atan2(t, Math.cos(dl));
  const eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let e = eta;
  let n = xi;
  for (let j = 1; j <= 3; j++) {
    e += ALPHA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    n += ALPHA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  return { e: E0 + K0 * AA * e, n: (z.south ? 10_000_000 : 0) + K0 * AA * n };
}

/** Easting and northing (metres) in a zone to latitude and longitude (degrees). */
export function fromUtm(e: number, n: number, z: Zone): { lat: number; lon: number } {
  const xi = (n - (z.south ? 10_000_000 : 0)) / (K0 * AA);
  const eta = (e - E0) / (K0 * AA);
  let xp = xi;
  let ep = eta;
  for (let j = 1; j <= 3; j++) {
    xp -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    ep -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xp) / Math.cosh(ep));
  let phi = chi;
  for (let j = 1; j <= 3; j++) phi += DELTA[j - 1] * Math.sin(2 * j * chi);
  return { lat: phi / DEG, lon: centralMeridian(z) + Math.atan2(Math.sinh(ep), Math.cos(xp)) / DEG };
}
