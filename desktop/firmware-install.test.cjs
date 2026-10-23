const test = require('node:test');
const assert = require('node:assert/strict');
const { validateUf2, isBootDriveInfo, windowsDriveRoot, copyFirmwareToDrive, createFirmwareInstaller } = require('./firmware-install.cjs');

function image(blocks = 2) {
  const bytes = Buffer.alloc(blocks * 512);
  for (let i = 0; i < blocks; i++) {
    const header = [0x0a324655, 0x9e5d5157, 0x2000, 0x10000000 + i * 256, 256, i, blocks, 0xe48bff56];
    header.forEach((value, field) => bytes.writeUInt32LE(value, i * 512 + field * 4));
    bytes.fill(i + 1, i * 512 + 32, i * 512 + 288);
    bytes.writeUInt32LE(0x0ab16f30, i * 512 + 508);
  }
  return bytes;
}
const bootInfo = 'UF2 Bootloader v3.0\r\nModel: Raspberry Pi RP2\r\nBoard-ID: RPI-RP2\r\n';

test('validates the complete RP2040 image, including out-of-order blocks', () => {
  const bytes = image();
  assert.deepEqual(validateUf2(bytes), { blocks: 2, bytes: 1024 });
  assert.doesNotThrow(() => validateUf2(Buffer.concat([bytes.subarray(512), bytes.subarray(0, 512)])));
});

test('rejects fake, truncated, wrong-family, overlapping and malformed firmware', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from('// simulated firmware'), image().subarray(0, 700), image().subarray(0, 512)]) {
    assert.throws(() => validateUf2(bytes));
  }
  const defects = [[0, 0], [4, 0], [8, 0], [8, 0x2001], [12, 0x20000000],
    [12, 0x101fff80], [12, 0x10000001], [16, 476], [20, 3], [24, 100], [28, 0xe48bff59], [508, 0],
    [512 + 12, 0x10000000], [512 + 20, 0]];
  for (const [offset, value] of defects) {
    const bytes = image(); bytes.writeUInt32LE(value, offset);
    assert.throws(() => validateUf2(bytes), `${offset}: ${value}`);
  }
  const noBoot = image(); noBoot.writeUInt32LE(0x10000200, 12);
  assert.throws(() => validateUf2(noBoot), /boot block/);
});

test('only accepts a local Windows drive root and RP2040 boot marker', () => {
  assert.equal(windowsDriveRoot('E:\\'), 'E:\\');
  assert.equal(windowsDriveRoot('e:/'), 'e:\\');
  for (const name of ['E:', 'E:\\folder', '..', '\\\\server\\share\\', '\\\\?\\E:\\', '/media/RPI-RP2', null]) {
    assert.throws(() => windowsDriveRoot(name));
  }
  assert.equal(isBootDriveInfo(bootInfo), true);
  for (const text of ['', 'Board-ID: RPI-RP2', bootInfo.replace('RPI-RP2', 'RP2350'), bootInfo.replace('RPI-RP2', 'RPI-RP2-other')]) {
    assert.equal(isBootDriveInfo(text), false);
  }
});

test('copies exact bytes only to a validated drive with an exclusive, flushed write', async () => {
  const bytes = image(); const calls = [];
  const io = {
    readFile: async (file, encoding) => { calls.push(file); assert.equal(encoding, 'utf8'); return bootInfo; },
    writeFile: async (file, data, options) => {
      calls.push(file); assert.deepEqual(data, bytes); assert.deepEqual(options, { flag: 'wx', flush: true });
    },
  };
  assert.deepEqual(await copyFirmwareToDrive('E:\\', bytes, io), { status: 'copied' });
  assert.deepEqual(calls, ['E:\\INFO_UF2.TXT', 'E:\\DriftPad.uf2']);
});

test('rejects the wrong drive or unreadable marker before writing', async () => {
  for (const mode of ['wrong', 'missing']) {
    let writes = 0;
    await assert.rejects(copyFirmwareToDrive('E:\\', image(), {
      readFile: async () => { if (mode === 'missing') throw new Error('unplugged'); return 'ordinary drive'; },
      writeFile: async () => { writes++; },
    }));
    assert.equal(writes, 0);
  }
});

function setup(overrides = {}) {
  const calls = { read: 0, choose: 0, write: 0 };
  const install = createFirmwareInstaller({
    isAllowed: () => true,
    readFirmware: async () => { calls.read++; return image(); },
    chooseDrive: async () => { calls.choose++; return { canceled: false, filePaths: ['E:\\'] }; },
    io: { readFile: async () => bootInfo, writeFile: async () => { calls.write++; } },
    ...overrides,
  });
  return { install, calls };
}

test('untrusted callers cannot read firmware, show dialogs, or write', async () => {
  const { install, calls } = setup({ isAllowed: () => false });
  assert.equal((await install({})).status, 'error');
  assert.deepEqual(calls, { read: 0, choose: 0, write: 0 });
});

test('cancelling or closing the window before selection never writes', async () => {
  const cancelled = setup({ chooseDrive: async () => ({ canceled: true, filePaths: [] }) });
  assert.equal((await cancelled.install({})).status, 'cancelled');
  assert.equal(cancelled.calls.write, 0);
  let allowed = true;
  const closed = setup({ isAllowed: () => allowed, chooseDrive: async () => {
    allowed = false; return { canceled: false, filePaths: ['E:\\'] };
  } });
  assert.equal((await closed.install({})).status, 'cancelled');
  assert.equal(closed.calls.write, 0);
});

test('invalid bundled firmware is rejected before opening the drive picker', async () => {
  const { install, calls } = setup({ readFirmware: async () => Buffer.from('invalid') });
  assert.equal((await install({})).status, 'error');
  assert.equal(calls.choose, 0); assert.equal(calls.write, 0);
});

test('a concurrent install is rejected and cancellation releases the lock', async () => {
  let resolvePicker;
  const busy = [];
  const { install } = setup({ onBusyChange: (value) => busy.push(value),
    chooseDrive: () => new Promise((resolve) => { resolvePicker = resolve; }) });
  const first = install({});
  await new Promise(setImmediate);
  assert.match((await install({})).message, /already open/);
  resolvePicker({ canceled: true });
  assert.equal((await first).status, 'cancelled');
  const next = install({}); await new Promise(setImmediate);
  resolvePicker({ canceled: true });
  assert.equal((await next).status, 'cancelled');
  assert.deepEqual(busy, [true, false, true, false]);
});

test('failed writes are never reported as success and retry is possible', async () => {
  let fail = true;
  const { install } = setup({ io: { readFile: async () => bootInfo, writeFile: async () => {
    if (fail) throw Object.assign(new Error('disconnected'), { code: 'EIO' });
  } } });
  assert.deepEqual(await install({}), { status: 'error', message: 'The copy could not be confirmed. Check the cable and reconnect in BOOTSEL mode before retrying.' });
  fail = false;
  assert.deepEqual(await install({}), { status: 'copied' });
});
