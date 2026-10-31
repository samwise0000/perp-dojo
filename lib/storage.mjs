// Where "Save to server" puts the snapshot: one gzip file per Bybit account.
// On Vercel that's Blob (private store, one write per save, always the same
// path). Locally without a Blob token it's a file under data/.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.PERP_DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url));
const useBlob = () => !!process.env.BLOB_READ_WRITE_TOKEN;
export const storageKind = () => (useBlob() ? 'blob' : process.env.VERCEL ? 'none' : 'file');
const pathname = uid => `perp-dojo/${String(uid).replace(/\D/g, '') || 'default'}/snapshot.json.gz`;

export async function putSnapshot(uid, buf) {
  if (useBlob()) {
    const { put } = await import('@vercel/blob');
    await put(pathname(uid), buf, { access: 'private', contentType: 'application/gzip', addRandomSuffix: false, allowOverwrite: true });
    return;
  }
  if (process.env.VERCEL) throw new Error('No Blob store is connected to this project yet.');
  const f = path.join(DATA_DIR, pathname(uid));
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, buf, { mode: 0o600 });
}

export async function getSnapshot(uid) {
  if (useBlob()) {
    const { get } = await import('@vercel/blob');
    try {
      const r = await get(pathname(uid), { access: 'private' });
      return r ? Buffer.from(await new Response(r.stream).arrayBuffer()) : null;
    } catch (e) {
      if (/not.?found/i.test(e?.name + ' ' + e?.message)) return null;
      throw e;
    }
  }
  if (process.env.VERCEL) return null;
  try { return await fs.readFile(path.join(DATA_DIR, pathname(uid))); } catch { return null; }
}
