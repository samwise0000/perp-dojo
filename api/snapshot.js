// GET  /api/snapshot → the last saved snapshot (gzip bytes), or 404.
// POST /api/snapshot → save one (gzip bytes). One Blob write per click.
// The page compresses and decompresses; this function never parses the data.
import { json, authorized, rawBody } from '../lib/http.mjs';
import { checkKey } from '../lib/session.mjs';
import { putSnapshot, getSnapshot, storageKind } from '../lib/storage.mjs';

const LIMIT = 4_300_000;   // Vercel's request body limit is 4.5 MB

export default async function handler(req, res) {
  if (!authorized(req, res)) return;
  if (storageKind() === 'none') return json(res, 503, { error: 'No Blob store is connected to this project yet.' });
  const key = await checkKey();
  if (!key.ok) return json(res, 403, { error: key.message });
  try {
    if (req.method === 'GET') {
      const buf = await getSnapshot(key.uid);
      if (!buf) return json(res, 404, { error: 'Nothing has been saved to the server yet.' });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/gzip');
      res.setHeader('cache-control', 'no-store');
      return res.end(buf);
    }
    if (req.method === 'POST') {
      const buf = await rawBody(req, LIMIT);
      if (buf.length < 20 || buf[0] !== 0x1f || buf[1] !== 0x8b) return json(res, 400, { error: 'Expected a gzip snapshot.' });
      if (buf.length > LIMIT) return json(res, 413, { error: 'Snapshot is too large to upload.' });
      await putSnapshot(key.uid, buf);
      return json(res, 200, { ok: true, bytes: buf.length, savedAt: Date.now(), storage: storageKind() });
    }
    res.setHeader('allow', 'GET, POST');
    json(res, 405, { error: 'Method not allowed.' });
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
}
