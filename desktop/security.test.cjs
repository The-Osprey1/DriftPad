const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { resolveAsset, isAppUrl, isProjectLink } = require('./security.cjs');
const { selectSerialPort } = require('./serial-picker.cjs');
test('serves only packaged app assets', () => {
  const root = path.resolve('test-renderer');
  assert.equal(resolveAsset(root, 'driftpad://app/'), path.join(root, 'index.html'));
  assert.equal(resolveAsset(root, 'driftpad://app/assets/app.js'), path.join(root, 'assets', 'app.js'));
  for (const url of ['https://app/index.html', 'driftpad://evil/index.html', 'driftpad://app/%2e%2e%2fsecret', 'driftpad://app/%5c..%5csecret', 'driftpad://app/C:%5csecret', 'driftpad://app/%00secret', 'driftpad://app/%bad', 'driftpad://user@app/a']) {
    assert.equal(resolveAsset(root, url), null, url);
  }
  assert.equal(isAppUrl('driftpad://app.evil/'), false);
});
test('opens only project HTTPS links externally', () => {
  assert.equal(isProjectLink('https://github.com/The-Osprey1/DriftPad/releases'), true);
  for (const url of ['file:///secret', 'javascript:alert(1)', 'https://evil.com', 'https://github.com.evil/The-Osprey1/DriftPad', 'https://github.com/The-Osprey1/DriftPad-evil', 'https://user@github.com/The-Osprey1/DriftPad']) assert.equal(isProjectLink(url), false, url);
});
const ports = [{ portId: 'one', portName: 'COM3', displayName: 'Pico' }, { portId: 'two', portName: 'COM4' }];
test('serial selection uses an explicit choice and releases listeners', async () => {
  const session = new EventEmitter();
  const selected = await selectSerialPort({ ports, session, isAlive: () => true, showDialog: async (options) => {
    assert.equal(options.buttons[0], 'Cancel');
    assert.equal(options.defaultId, 0);
    return { response: 2 };
  } });
  assert.equal(selected, 'two');
  assert.equal(session.listenerCount('serial-port-removed'), 0);
});
test('cancel, unplug, missing ports and closed window do not connect', async () => {
  for (const scenario of ['cancel', 'unplug', 'empty', 'closed']) {
    const session = new EventEmitter();
    const selected = await selectSerialPort({ ports: scenario === 'empty' ? [] : ports, session,
      isAlive: () => scenario !== 'closed', showDialog: async () => {
        if (scenario === 'unplug') session.emit('serial-port-removed', {}, ports[0]);
        return { response: scenario === 'cancel' ? 0 : 1 };
      } });
    assert.equal(selected, '', scenario);
    assert.equal(session.listenerCount('serial-port-removed'), 0);
  }
});
test('serial dialog failures release the removal listener', async () => {
  const session = new EventEmitter();
  await assert.rejects(selectSerialPort({ ports, session, isAlive: () => true, showDialog: async () => { throw new Error('closed'); } }));
  assert.equal(session.listenerCount('serial-port-removed'), 0);
});
