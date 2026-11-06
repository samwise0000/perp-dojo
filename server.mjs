// Perp Dojo — local server. Serves public/ and routes /api/* to the same
// functions Vercel runs (api/*.js), so local and deployed behave alike.
// The Bybit key stays in this process; the browser only ever sees trades.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import status from './api/status.js';
import account from './api/account.js';
import pull from './api/pull.js';
import snapshot from './api/snapshot.js';
import klines from './api/klines.js';
import flow from './api/flow.js';
import positions from './api/positions.js';
import sfpAlert from './api/sfp-alert.js';
import { json } from './lib/http.mjs';

const PORT = Number(process.env.PORT) || 8090;
const HOST = '127.0.0.1';
const PUBLIC = fileURLToPath(new URL('./public', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const ROUTES = { '/api/status': status, '/api/account': account, '/api/pull': pull, '/api/snapshot': snapshot, '/api/klines': klines, '/api/flow': flow, '/api/positions': positions, '/api/sfp-alert': sfpAlert };

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return json(res, 404, { error: 'not found' });
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch { json(res, 404, { error: 'not found' }); }
}

const server = http.createServer(async (req, res) => {
  // Only answer to this machine's own pages: blocks other websites (and DNS rebinding) from reading your trades.
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1'].includes(host)) return json(res, 403, { error: 'forbidden' });
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return json(res, 403, { error: 'forbidden' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    const route = ROUTES[url.pathname];
    if (route) { req.query = Object.fromEntries(url.searchParams); return await route(req, res); }
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    return serveStatic(res, url.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Perp Dojo running at http://localhost:${PORT}`);
  if (!process.env.BYBIT_API_KEY) console.log('No API key found — copy .env.example to .env and add a read-only key.');
});
