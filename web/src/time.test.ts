import assert from 'node:assert/strict';
import test from 'node:test';
import { fmtClock } from './time';

test('log times are local, like every other time on the page', () => {
  const tz = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    assert.match(fmtClock('2026-11-11T18:25:24.418Z'), /^10:25:24/);
    process.env.TZ = 'Asia/Tokyo';
    assert.match(fmtClock('2026-11-11T18:25:24.418Z'), /^0?3:25:24/);
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
  assert.equal(fmtClock(''), '');
  assert.equal(fmtClock('not a time'), '');
});
