import assert from 'node:assert/strict';
import test from 'node:test';
import { PRODUCTIVITY_PROFILES } from '../types/driftpad';
import { getValidatedBackupProfiles, validateProductivityProfiles } from './profileValidation';

test('accepts the built-in profiles', () => {
  assert.equal(validateProductivityProfiles(PRODUCTIVITY_PROFILES), true);
});

test('rejects malformed layer and key data', () => {
  const invalid = structuredClone(PRODUCTIVITY_PROFILES);
  invalid[0].layers[1] = invalid[0].layers[1].slice(0, 15);
  assert.equal(validateProductivityProfiles(invalid), false);
});

test('rejects duplicate profile identifiers', () => {
  const invalid = structuredClone(PRODUCTIVITY_PROFILES);
  invalid[1].id = invalid[0].id;
  assert.equal(validateProductivityProfiles(invalid), false);
});

test('extracts only validated backup profiles', () => {
  const valid = getValidatedBackupProfiles({
    driftpad_version: '2.0',
    active_profile_id: PRODUCTIVITY_PROFILES[0].id,
    profiles: PRODUCTIVITY_PROFILES,
  });
  assert.equal(valid?.length, PRODUCTIVITY_PROFILES.length);
  assert.equal(getValidatedBackupProfiles({ profiles: [] }), null);
});

test('accepts older backups below the firmware minimum and raises them to it', () => {
  const older = structuredClone(PRODUCTIVITY_PROFILES);
  older[0].tuning.actuation = 0.1;
  older[0].layers[0][0].customActuation = 0.2;
  const restored = getValidatedBackupProfiles({ profiles: older });
  assert.ok(restored);
  assert.equal(restored[0].tuning.actuation, 0.25);
  assert.equal(restored[0].layers[0][0].customActuation, 0.25);
  assert.deepEqual(restored[1], PRODUCTIVITY_PROFILES[1]);
});

test('rejects actuation outside every supported range', () => {
  const invalid = structuredClone(PRODUCTIVITY_PROFILES);
  invalid[0].tuning.actuation = 0.05;
  assert.equal(validateProductivityProfiles(invalid), false);
  invalid[0].tuning.actuation = 3.81;
  assert.equal(validateProductivityProfiles(invalid), false);
});
