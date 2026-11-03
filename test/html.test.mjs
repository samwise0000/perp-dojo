import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The page looks elements up by id; a repeated id silently wires up the wrong one.
test('every id in index.html is unique', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dup, []);
});
