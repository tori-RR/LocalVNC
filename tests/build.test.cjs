const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('noVNC workaround matches installed locked package and fails closed on drift', async () => {
  const { patchNovncBrowser } = await import('../scripts/novnc-compat.mjs');
  const source = fs.readFileSync(path.join(__dirname,'../node_modules/@novnc/novnc/lib/util/browser.js'),'utf8');
  const patched = patchNovncBrowser(source);
  assert(!patched.includes('= await _checkWebCodecsH264DecodeSupport();'));
  assert.throws(() => patchNovncBrowser(patched), /exactly once/);
  assert.throws(() => patchNovncBrowser(source + source), /exactly once/);
});
