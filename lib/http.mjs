// Tiny request helpers shared by the Vercel functions in api/ and the local server.
import crypto from 'node:crypto';

export function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

export const query = req => req.query ?? Object.fromEntries(new URL(req.url, 'http://x').searchParams);

// The raw request body as a Buffer. Vercel may have parsed it already.
export async function rawBody(req, limit) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'binary');
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) { const e = new Error('Snapshot is too large to upload.'); e.status = 413; throw e; }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const digest = s => crypto.createHash('sha256').update(String(s)).digest();

// Every API call needs the PERP_PASSWORD (sent as x-perp-key). Required on Vercel;
// optional locally, where the server only listens on 127.0.0.1 anyway.
export function authorized(req, res) {
  const pw = (process.env.PERP_PASSWORD || '').trim();
  if (!pw) {
    if (process.env.VERCEL) { json(res, 500, { error: 'PERP_PASSWORD is not set on the server.' }); return false; }
    return true;
  }
  const got = String(req.headers['x-perp-key'] || '');
  if (!crypto.timingSafeEqual(digest(got), digest(pw))) { json(res, 401, { error: 'Wrong password.', needsPassword: true }); return false; }
  return true;
}
