// Requires the explicit Rust browser_tlsvnc_fixture and the Vite fixture on
// debug-only allowed origin http://127.0.0.1:1420. Never uses production state.
const assert = (await import('node:assert/strict')).default;
const task = await taskSpace('LocalVNC review 780f51f validation');
const page = task.page('p1');
for (const wait of [45, 90]) {
  const query = new URLSearchParams({ mode: 'direct', password: '1', bridgeUrl: globalThis.TLS_BRIDGE });
  await page.goto(`http://127.0.0.1:1420/tests/fixtures/workspace.html?${query}`);
  await page.waitForSelector('#connect:not([disabled])');
  await page.click('#connect');
  await page.waitForFunction(() => document.querySelector('#password-dialog').open);
  console.log({ waitingForCredentials: wait });
  for (let elapsed = 0; elapsed < wait; elapsed += 45) await page.waitForTimeout(45000);
  assert.equal(await page.evaluate(() => document.querySelector('#password-dialog').open), true);
  await page.fill('#password', 'SYNTHETIC_PASSWORD');
  await page.evaluate(() => { document.querySelector('#remember-password').checked = false; });
  await page.click('#password-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#stage-status').textContent === '已连接');
  console.log({ F01: 'PASS', waitedSeconds: wait,
    state: await page.evaluate(() => ({ status: document.querySelector('#stage-status').textContent,
      canvases: document.querySelectorAll('#screen canvas').length })) });
  await page.click('#connect');
}
console.log(await page.snapshot());
