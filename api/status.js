// GET /api/status → is the key read-only, and where would "Save to server" go.
// Never touches Blob.
import { json, authorized, query } from '../lib/http.mjs';
import { checkKey } from '../lib/session.mjs';
import { storageKind } from '../lib/storage.mjs';

const DAY = 86_400_000;

export default async function handler(req, res) {
  if (!authorized(req, res)) return;
  const key = await checkKey('recheck' in query(req));
  json(res, 200, { key, storage: storageKind(), earliest: Date.now() - 730 * DAY + DAY, passwordSet: !!process.env.PERP_PASSWORD });
}
