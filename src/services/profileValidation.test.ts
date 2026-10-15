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

test('rejects oversized profile fields and excessive array counts', () => {
  const invalidName = structuredClone(PRODUCTIVITY_PROFILES);
  invalidName[0].name = 'A'.repeat(65);
  assert.equal(validateProductivityProfiles(invalidName), false);

  const invalidDesc = structuredClone(PRODUCTIVITY_PROFILES);
  invalidDesc[0].description = 'B'.repeat(257);
  assert.equal(validateProductivityProfiles(invalidDesc), false);

  const invalidKeyDesc = structuredClone(PRODUCTIVITY_PROFILES);
  invalidKeyDesc[0].layers[0][0].description = 'C'.repeat(129);
  assert.equal(validateProductivityProfiles(invalidKeyDesc), false);

  const excessiveProfiles = Array.from({ length: 51 }, (_, i) => {
    const p = structuredClone(PRODUCTIVITY_PROFILES[0]);
    p.id = `profile-${i}`;
    return p;
  });
  assert.equal(validateProductivityProfiles(excessiveProfiles), false);
});
