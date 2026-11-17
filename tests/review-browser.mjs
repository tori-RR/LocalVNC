// Run via ego-browser nodejs after setting globalThis.REVIEW_URL to the
// loopback WORKSPACE_URL printed by tests/vnc-browser-fixture.cjs.
const assert = (await import('node:assert/strict')).default;
const task = await taskSpace('LocalVNC review 780f51f validation');
const page = task.page('p1');
console.log({ taskSpaceId: task.spaceId });
await page.goto(`${globalThis.REVIEW_URL}?mode=direct&save=once`);
await page.waitForSelector('#edit-server:not([disabled])');
console.log(await page.snapshot());
await page.click('#edit-server');
await page.selectOption('#server-kind', 'pve');
await page.fill('[name=vmid]', '0');
await page.selectOption('#server-kind', 'direct');
await page.click('#server-save');
await page.waitForFunction(() => document.querySelector('#server-form-error').textContent.includes('模拟保存冲突'));
const failure = await page.evaluate(() => {
  const field = document.querySelector('[name=vmid]');
  return { disabled: field.disabled, willValidate: field.willValidate,
    draft: field.value, valid: document.querySelector('#server-form').checkValidity() };
});
assert.deepEqual(failure, { disabled: true, willValidate: false, draft: '0', valid: true });
await page.click('#server-save');
await page.waitForFunction(() => !document.querySelector('#server-dialog').open);
console.log({ F06: 'PASS', failure });

await page.click('#connect');
await page.waitForFunction(() => document.querySelector('#stage-status').textContent === '已连接');
await page.click('#edit-server');
await page.fill('[name=name]', 'Renamed synthetic desktop');
await page.click('#server-save');
await page.waitForFunction(() => !document.querySelector('#server-dialog').open);
const renamed = await page.evaluate(() => ({ status: document.querySelector('#stage-status').textContent,
  title: document.querySelector('#stage-title').textContent,
  frames: document.querySelectorAll('#screen canvas').length }));
assert.deepEqual(renamed, { status: '已连接', title: 'Renamed synthetic desktop', frames: 1 });
console.log({ F05: 'PASS', renamed });

// Use the real noVNC encoder and synthetic RFB's packet recorder.
await page.click('.vnc-input-overlay');
await page.click('#toggle-keyboard');
await page.click('[data-code=CapsLock]');
await page.click('[data-code=ControlLeft]');
await page.click('[data-code=KeyC]');
await page.waitForFunction(async () => (await (await fetch('/__fixture/events')).json()).events.some(event => event.kind === 'key'));
const packets = await page.evaluate(async () => (await (await fetch('/__fixture/events')).json()).events.filter(event => event.kind === 'key'));
const downs = packets.filter(event => event.down).map(event => event.keysym);
assert.deepEqual(downs, [0xffe3, 0x63]);
assert.deepEqual(packets.filter(event => !event.down).map(event => event.keysym), [0x63, 0xffe3]);
console.log({ F04: 'PASS', packets });
await page.click('#connect');
console.log(await page.snapshot());
// Finish the task space separately after the caller has inspected this result.
