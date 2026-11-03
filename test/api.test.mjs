// The real server (same functions Vercel runs) against the mock Bybit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMock, MOCK_KEY, MOCK_SECRET } from './mock-bybit.mjs';

const PORT = 8097, BASE = `http://localhost:${PORT}`, PW = 'correct horse';
let mock, app, dir, sent;

before(async () => {
  ({ server: mock, telegram: sent } = await startMock({ port: 9996 }));
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perp-api-'));
  app = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, PORT: String(PORT), PERP_DATA_DIR: dir, PERP_PASSWORD: PW, BLOB_READ_WRITE_TOKEN: '',
      BYBIT_API_KEY: MOCK_KEY, BYBIT_API_SECRET: MOCK_SECRET, BYBIT_BASE_URL: 'http://127.0.0.1:9996',
      ALERT_SECRET: 'alert-secret', TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_CHAT_ID: '42', TELEGRAM_API_BASE: 'http://127.0.0.1:9996', SFP_PAIRS: 'BTC SOL' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
});
after(async () => { app.kill(); mock.close(); await fs.rm(dir, { recursive: true, force: true }); });

const call = (p, opts = {}) => fetch(BASE + p, { ...opts, headers: { 'x-perp-key': PW, ...(opts.headers || {}) } });

test('every API route needs the password', async () => {
  for (const p of ['/api/status', '/api/account', '/api/pull?category=linear&start=0&end=1', '/api/snapshot']) {
    const r = await fetch(BASE + p, { headers: { 'x-perp-key': 'nope' } });
    assert.equal(r.status, 401, p);
  }
  const ok = await (await call('/api/status')).json();
  assert.equal(ok.key.ok, true);
  assert.equal(ok.storage, 'file');
});

test('pull returns one window and refuses longer ones', async () => {
  const now = Date.now(), W = 7 * 86_400_000;
  const r = await (await call(`/api/pull?category=linear&start=${now - W + 1}&end=${now}`)).json();
  assert.ok(Array.isArray(r.rows) && Array.isArray(r.fills));
  assert.ok(r.fills.every(f => f.id && f.o && f.t));
  assert.equal((await call(`/api/pull?category=linear&start=${now - W - 1000}&end=${now}`)).status, 400);
  assert.equal((await call(`/api/pull?category=spot&start=${now - 1000}&end=${now}`)).status, 400);
});

test('snapshot: nothing at first, then a gzip round trip; non-gzip is refused', async () => {
  assert.equal((await call('/api/snapshot')).status, 404);
  const snap = { app: 'perp-dojo', v: 1, savedAt: 1, cache: { raw: { a: 1 } }, journal: { '2026-10-14': { text: 'hi' } } };
  const save = await call('/api/snapshot', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: gzipSync(JSON.stringify(snap)) });
  assert.equal(save.status, 200);
  const back = JSON.parse(gunzipSync(Buffer.from(await (await call('/api/snapshot')).arrayBuffer())));
  assert.deepEqual(back, snap);
  const bad = await call('/api/snapshot', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: '{"not":"gzip"}' });
  assert.equal(bad.status, 400);
});

test('klines: candles for the replay, oldest first, inputs checked', async () => {
  const end = Date.now(), start = end - 3_600_000;
  const r = await call(`/api/klines?category=linear&symbol=BTCUSDT&interval=5&start=${start}&end=${end}`);
  assert.equal(r.status, 200);
  const { candles } = await r.json();
  assert.ok(candles.length > 5);
  assert.ok(candles.every((c, i) => i === 0 || c.t > candles[i - 1].t));
  assert.ok(candles.every(c => c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c)));
  for (const bad of ['category=spot&symbol=BTCUSDT&interval=5', 'category=linear&symbol=btc/usdt&interval=5', 'category=linear&symbol=BTCUSDT&interval=7'])
    assert.equal((await call(`/api/klines?${bad}&start=${start}&end=${end}`)).status, 400);
  assert.equal((await fetch(`${BASE}/api/klines?category=linear&symbol=BTCUSDT&interval=5&start=${start}&end=${end}`, { headers: { 'x-perp-key': 'nope' } })).status, 401);
});

test('positions: open ones only, with stop-loss risk and open time', async () => {
  const r = await call('/api/positions');
  const j = await r.json();
  assert.equal(j.available, true);
  assert.deepEqual(j.positions.map(p => p.symbol).sort(), ['BTCUSDT', 'SOLUSDT']);
  const sol = j.positions.find(p => p.symbol === 'SOLUSDT');
  assert.equal(sol.sl, null);
  assert.equal(sol.dir, 'Short');
});

test('sfp-alert: needs the alert secret, sends through Telegram, dry runs send nothing', async () => {
  assert.equal((await fetch(`${BASE}/api/sfp-alert?phase=pre`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/sfp-alert?phase=pre&key=nope`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/sfp-alert?phase=soon&key=alert-secret`)).status, 400);

  const test = await fetch(`${BASE}/api/sfp-alert?phase=test`, { headers: { authorization: 'Bearer alert-secret' } });
  assert.equal(test.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].token, 'bot-token');
  assert.equal(sent[0].chat_id, '42');
  assert.equal(sent[0].parse_mode, 'HTML');

  for (const phase of ['pre', 'close']) {
    const r = await fetch(`${BASE}/api/sfp-alert?phase=${phase}&dry=1&key=alert-secret`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.sent, false);
    assert.deepEqual(j.errors, []);
    assert.ok(Array.isArray(j.setups));
  }
  assert.equal(sent.length, 1);
});
