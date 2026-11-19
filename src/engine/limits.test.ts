import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  LIMITS_CMM,
  clampActuationMm,
  clampRtSensMm,
  isActuationMm,
  isRtSensMm,
} from './limits';

const header = readFileSync(new URL('../../firmware/include/settings_limits.h', import.meta.url), 'utf8');

const firmwareConstant = (name: string): number => {
  const match = header.match(new RegExp(`constexpr\\s+uint16_t\\s+${name}\\s*=\\s*(\\d+)\\s*;`));
  assert.ok(match, `${name} not found in firmware/include/settings_limits.h`);
  return Number(match[1]);
};

test('the Studio limits are the firmware limits', () => {
  for (const [name, value] of Object.entries(LIMITS_CMM)) {
    assert.equal(value, firmwareConstant(name), `${name} differs from firmware/include/settings_limits.h`);
  }
});

test('clamps and range checks use the firmware limits', () => {
  assert.equal(clampActuationMm(0.1), 0.25);
  assert.equal(clampActuationMm(9), 3.8);
  assert.equal(clampActuationMm(1.234), 1.23);
  assert.equal(clampRtSensMm(0), 0.1);
  assert.equal(clampRtSensMm(5), 2);
  assert.equal(isActuationMm(0.2), false);
  assert.equal(isActuationMm(0.25), true);
  assert.equal(isActuationMm(Number.NaN), false);
  assert.equal(isRtSensMm(0.1), true);
  assert.equal(isRtSensMm(2.01), false);
});
