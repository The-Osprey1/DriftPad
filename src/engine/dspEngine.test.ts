import assert from 'node:assert/strict';
import test from 'node:test';
import { DriftPadDspEngine } from './dspEngine';
import { INITIAL_DEVICE_CONFIG } from '../types/driftpad';

const installStorage = () => {
  const values = new Map<string, string>();
  (globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
};

test('matches protocol responses for core settings', () => {
  installStorage();
  const engine = new DriftPadDspEngine();

  assert.deepEqual(JSON.parse(engine.processCommand('PING')), { type: 'pong' });
  assert.equal(JSON.parse(engine.processCommand('SET_LAYER 2')).status, 'ok');
  assert.equal(engine.getConfig().active_layer, 2);
  assert.equal(JSON.parse(engine.processCommand('SET_ACTUATION 9')).status, 'error');
  assert.equal(JSON.parse(engine.processCommand('SET_RT_SENS 0.25')).status, 'ok');
  assert.equal(JSON.parse(engine.processCommand('SET_HID 0')).hid_output, false);
  engine.dispose();
});

test('applies per-key actuation and emits simulated events', () => {
  installStorage();
  const events: string[] = [];
  const engine = new DriftPadDspEngine((line) => events.push(line));
  const config = structuredClone(INITIAL_DEVICE_CONFIG);
  config.layers[0][0].customActuation = 3.5;
  engine.setConfig(config);

  assert.equal(engine.injectTravel(0, 2.5).pressed, false);
  assert.equal(engine.injectTravel(0, 3.5).pressed, true);
  assert.equal(engine.injectTravel(0, 0).pressed, false);
  assert.equal(events.some((line) => line.includes('"pressed":true')), true);
  engine.dispose();
});

test('streaming emits status telemetry and stops cleanly', async () => {
  installStorage();
  const events: string[] = [];
  const engine = new DriftPadDspEngine((line) => events.push(line));

  assert.equal(JSON.parse(engine.processCommand('STREAM 1')).streaming, true);
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(events.some((line) => line.includes('"type":"status"')), true);
  assert.equal(JSON.parse(engine.processCommand('STREAM 0')).streaming, false);
  engine.dispose();
});
