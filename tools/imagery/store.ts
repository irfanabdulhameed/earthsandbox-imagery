// Where the world's archives go: a local folder, or any S3-compatible bucket (AWS S3, Cloudflare R2, MinIO) through plain
// HTTPS with AWS Signature Version 4. Nothing secret lives in the repository: the bucket comes from the environment.
//
//   IMAGERY_OUT=./world-out                      a local folder (the default)
//   IMAGERY_S3_BUCKET=earth-photo                a bucket instead, with
//   IMAGERY_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   (or https://s3.us-west-2.amazonaws.com)
//   IMAGERY_S3_REGION=auto                       (R2: auto; S3: the bucket's region)
//   IMAGERY_S3_ACCESS_KEY_ID=…  IMAGERY_S3_SECRET_ACCESS_KEY=…
//   IMAGERY_S3_PREFIX=world/                     (optional key prefix)

import { createHash, createHmac } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Store {
  describe: string;
  /** Bytes of an object, or null when it is not there. */
  get(key: string): Promise<Uint8Array | null>;
  /** A byte range of an object (fewer bytes at its end), or null when it is not there. */
  getRange(key: string, start: number, length: number): Promise<Uint8Array | null>;
  /** Writes an object whole (atomically for a folder: a temporary name, then a rename). */
  put(key: string, data: Uint8Array, contentType?: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Objects written and bytes sent, for the cost log. */
  stats: { puts: number; gets: number; bytesUp: number };
}

export function folderStore(root: string): Store {
  const stats = { puts: 0, gets: 0, bytesUp: 0 };
  return {
    describe: `folder ${root}`,
    stats,
    async get(key) {
      const p = join(root, key);
      stats.gets++;
      return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
    },
    async getRange(key, start, length) {
      const p = join(root, key);
      stats.gets++;
      if (!existsSync(p)) return null;
      const fd = openSync(p, 'r');
      try {
        const buf = Buffer.alloc(length);
        const n = readSync(fd, buf, 0, length, start);
        return new Uint8Array(buf.subarray(0, n));
      } finally {
        closeSync(fd);
      }
    },
    async put(key, data) {
      const p = join(root, key);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(`${p}.part`, data);
      renameSync(`${p}.part`, p);
      stats.puts++;
      stats.bytesUp += data.length;
    },
    async exists(key) {
      return existsSync(join(root, key));
    },
  };
}

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const encodeKey = (key: string) => key.split('/').map((p) => encodeURIComponent(p).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

/**
 * Signs a request with AWS Signature Version 4 (path-style: https://endpoint/bucket/key). Returns the headers to send.
 * `now` is "YYYYMMDDTHHMMSSZ".
 */
export function signV4(opts: {
  method: string;
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  headers: Record<string, string>;
  payloadHash: string;
  now: string;
  service?: string;
}): Record<string, string> {
  const service = opts.service ?? 's3';
  const date = opts.now.slice(0, 8);
  const headers: Record<string, string> = { ...opts.headers, host: opts.url.host, 'x-amz-content-sha256': opts.payloadHash, 'x-amz-date': opts.now };
  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const query = [...opts.url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [opts.method, opts.url.pathname, query, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), opts.payloadHash].join('\n');
  const scope = `${date}/${opts.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', opts.now, scope, sha256(canonical)].join('\n');
  const kDate = hmac(`AWS4${opts.secretAccessKey}`, date);
  const kSigning = hmac(hmac(hmac(kDate, opts.region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope},SignedHeaders=${names.join(';')},Signature=${signature}` };
}

export function s3Store(env: NodeJS.ProcessEnv): Store {
  const endpoint = env.IMAGERY_S3_ENDPOINT ?? '';
  const bucket = env.IMAGERY_S3_BUCKET ?? '';
  const region = env.IMAGERY_S3_REGION ?? 'auto';
  const accessKeyId = env.IMAGERY_S3_ACCESS_KEY_ID ?? '';
  const secretAccessKey = env.IMAGERY_S3_SECRET_ACCESS_KEY ?? '';
  const prefix = env.IMAGERY_S3_PREFIX ?? '';
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error('S3 store: set IMAGERY_S3_ENDPOINT, IMAGERY_S3_BUCKET, IMAGERY_S3_ACCESS_KEY_ID and IMAGERY_S3_SECRET_ACCESS_KEY');
  const stats = { puts: 0, gets: 0, bytesUp: 0 };
  const call = async (method: string, key: string, body?: Uint8Array, contentType?: string, range?: string) => {
    const url = new URL(`${endpoint.replace(/\/$/, '')}/${bucket}/${encodeKey(prefix + key)}`);
    for (let attempt = 0; ; attempt++) {
      const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      const headers: Record<string, string> = {};
      if (range) headers.range = range;
      if (body) {
        headers['content-length'] = String(body.length);
        if (contentType) headers['content-type'] = contentType;
      }
      const signed = signV4({ method, url, region, accessKeyId, secretAccessKey, headers, payloadHash: body ? sha256(body) : sha256(''), now });
      delete signed.host;
      try {
        const res = await fetch(url, { method, headers: signed, body: body ? Buffer.from(body) : undefined });
        if (res.status >= 500) throw new Error(`S3 ${method} ${key}: HTTP ${res.status}`);
        return res;
      } catch (err) {
        if (attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  };
  return {
    describe: `bucket ${bucket} at ${endpoint}${prefix ? ` (prefix ${prefix})` : ''}`,
    stats,
    async get(key) {
      stats.gets++;
      const res = await call('GET', key);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`S3 GET ${key}: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async getRange(key, start, length) {
      stats.gets++;
      const res = await call('GET', key, undefined, undefined, `bytes=${start}-${start + length - 1}`);
      if (res.status === 404 || res.status === 416) return null;
      if (!res.ok) throw new Error(`S3 GET ${key}: HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      return res.status === 200 ? buf.subarray(start, start + length) : buf;
    },
    async put(key, data, contentType = 'application/octet-stream') {
      const res = await call('PUT', key, data, contentType);
      if (!res.ok) throw new Error(`S3 PUT ${key}: HTTP ${res.status} ${await res.text()}`);
      stats.puts++;
      stats.bytesUp += data.length;
    },
    async exists(key) {
      stats.gets++;
      const res = await call('HEAD', key);
      return res.ok;
    },
  };
}

/** The store the environment asks for. */
export function storeFromEnv(env: NodeJS.ProcessEnv, defaultFolder: string): Store {
  return env.IMAGERY_S3_BUCKET ? s3Store(env) : folderStore(env.IMAGERY_OUT ?? defaultFolder);
}
