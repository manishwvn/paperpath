import assert from 'node:assert/strict';
import test from 'node:test';
import { nextResolution } from '../frontend/next-question.ts';

test('asks about one conflict before any missing required fact', () => {
  assert.deepEqual(nextResolution({ complete: false, conflicts: ['availability'], missing: ['name', 'email'] }), {
    field: 'availability', kind: 'conflict',
  });
});

test('asks for only the first required missing fact and never optional motivation', () => {
  assert.deepEqual(nextResolution({ complete: false, conflicts: [], missing: ['name', 'email', 'equipment'] }), {
    field: 'name', kind: 'missing',
  });
  assert.equal(nextResolution({ complete: true, conflicts: [], missing: [] }), null);
  assert.equal(nextResolution({ complete: false, conflicts: [], missing: ['motivation'] }), null);
});
