import test from 'node:test';
import assert from 'node:assert/strict';
import { rateLimitDetails, formatRateLimit } from '../benchmarking/run-errors.mjs';
import { runCardValues } from '../benchmarking/ui/run-library.mjs';

const error = 'API error 429 [request_id=fixture]: Subscription quota exhausted. Your usage window resets at 2026-10-12T23:21:10Z. (rate_limit_error)';
const options = { now: Date.parse('2026-10-12T20:00:10Z'), locale: 'en-US', timeZone: 'America/Boise' };

test('Meta quota errors show the local reset time and remaining wait', () => {
  const details = rateLimitDetails(error);
  assert.deepEqual(details, { reset_at: '2026-10-12T23:21:10.000Z' });
  assert.match(formatRateLimit(details, options), /Resets today at 5:21\s*PM MDT \(in 3h 21m\)\./);
  assert.equal(formatRateLimit(details, options).includes('2026-10-12T'), false);
  assert.deepEqual(rateLimitDetails(JSON.stringify({ error: { message: error } })), details);
});

test('reset timestamps accept explicit UTC and offsets, never guess a missing timezone', () => {
  assert.deepEqual(rateLimitDetails('Rate limit reached. Resets at 2026-10-12 23:21:10 UTC.'), rateLimitDetails(error));
  assert.deepEqual(rateLimitDetails('Too many requests. Retry at 2026-10-12T17:21:10-06:00.'), rateLimitDetails(error));
  for (const text of ['429 at 2026-10-12T23:21:10Z', 'Rate limit reached. Resets at 2026-10-12T23:21:10', 'HTTP 429: retry later']) {
    const details = rateLimitDetails(text);
    assert.deepEqual(details, { reset_at: null });
    assert.match(formatRateLimit(details, options), /did not report a reset time/);
  }
  assert.equal(rateLimitDetails('Engine failed at 2026-10-12T23:21:10Z'), null);
  assert.equal(formatRateLimit(null), null);
});

test('today and tomorrow follow the viewer’s calendar, including daylight-saving changes', () => {
  assert.match(formatRateLimit(rateLimitDetails(error), { ...options, now: Date.parse('2026-10-12T10:00:00Z'), timeZone: 'Asia/Tokyo' }), /tomorrow at 8:21/);
  assert.match(formatRateLimit({ reset_at: '2026-11-02T07:30:00Z' }, { ...options, now: Date.parse('2026-11-01T06:30:00Z') }), /tomorrow at 12:30\s*AM MST/);
});

test('past reset times and short waits do not promise a quota is available', () => {
  assert.match(formatRateLimit(rateLimitDetails(error), { ...options, now: Date.parse('2026-10-13T00:00:00Z') }), /reported reset time has passed/);
  assert.match(formatRateLimit(rateLimitDetails(error), { ...options, now: Date.parse('2026-10-12T23:20:50Z') }), /in less than a minute/);
});

test('failed run cards distinguish a rate limit from other failures', () => {
  const run = { model: 'muse-wonder-1.0', status: 'failed', rate_limit: rateLimitDetails(error) };
  assert.equal(runCardValues(run).status, 'Rate limited');
  assert.equal(runCardValues(run).statusTone, 'yellow');
  assert(runCardValues(run).rateLimit);
  assert.equal(runCardValues({ ...run, rate_limit: null }).status, 'failed');
  assert.equal(runCardValues({ ...run, rate_limit: null }).statusTone, 'red');
  assert.equal(runCardValues({ ...run, status: 'running' }).rateLimit, null);
  assert.equal(runCardValues({ ...run, status: 'running' }).statusTone, 'green');
  assert.equal(runCardValues({ ...run, status: 'paused' }).statusTone, 'gray');
});
