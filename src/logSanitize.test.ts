import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeLogMessage } from './logSanitize.js';

const RAW_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

test('a docker/npm progress line survives JSON serialisation', () => {
  const line = 'Pulling postgres\r\x1b[2K  45% done\x00\ttail\r\n';
  const message = sanitizeLogMessage(line);

  // The shape `GET /api/previews/:id` returns for one log row.
  const body = JSON.stringify({ logs: [{ id: 1, preview_id: 7, level: 'info', message }] });
  assert.doesNotThrow(() => JSON.parse(body));
  assert.equal(JSON.parse(body).logs[0].message, message);

  assert.ok(!RAW_CONTROL.test(message), 'no raw C0 control character is left in the message');
  assert.ok(!message.includes('\r'), 'carriage returns are normalised');
  assert.ok(!message.includes('\x1b'), 'escape sequences are removed');
  assert.ok(message.includes('45% done'), 'content is kept');
  assert.ok(message.includes('\t'), 'tabs are kept');
});

test('ordinary lines are untouched', () => {
  const line = 'Applying migrations... OK';
  assert.equal(sanitizeLogMessage(line), line);
});
