import { describe, expect, it } from 'vitest';
import { classifyGoogleRateLimit } from '../googlePoolPolicy';

const error = (details: unknown[], message = '') => JSON.stringify({ error: { message, details } });
const retry = (retryDelay: unknown) => ({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay });
const info = (reason: string, metadata: Record<string, unknown> = {}) => ({
  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
  reason,
  metadata,
});

describe('Google structured rate limit policy', () => {
  it('honors RetryInfo fractional seconds and protobuf duration objects', () => {
    expect(classifyGoogleRateLimit(error([retry('0.25s')]))).toEqual({ reason: 'rate-limited', retryAfterMs: 250 });
    expect(classifyGoogleRateLimit(error([retry({ seconds: '45', nanos: 500_000_000 })]))).toEqual({
      reason: 'rate-limited',
      retryAfterMs: 45_500,
    });
  });
  it('uses authoritative header seconds or HTTP dates before body hints without a 30 second cap', () => {
    const now = Date.parse('2026-10-12T12:00:00Z');
    expect(classifyGoogleRateLimit(error([retry('3s')]), '3600', now).retryAfterMs).toBe(3_600_000);
    expect(classifyGoogleRateLimit('{}', ['Mon, 12 Oct 2026 12:02:00 GMT'], now).retryAfterMs).toBe(120_000);
    expect(classifyGoogleRateLimit(error([retry('3s')]), '0', now).retryAfterMs).toBe(0);
  });
  it('retains explicit multi-day quota resets instead of inventing a five-hour window', () => {
    const now = Date.parse('2026-10-12T12:00:00Z');
    expect(
      classifyGoogleRateLimit(
        error([info('QUOTA_EXHAUSTED', { quotaResetTimeStamp: '2026-10-15T12:00:00Z' })]),
        undefined,
        now,
      ),
    ).toEqual({ reason: 'quota-exhausted', retryAfterMs: 3 * 24 * 3_600_000 });
    expect(classifyGoogleRateLimit(error([info('QUOTA_EXHAUSTED', { quotaResetDelay: '2h30m' })]))).toEqual({
      reason: 'quota-exhausted',
      retryAfterMs: 9_000_000,
    });
  });
  it('does not classify generic resource exhaustion or per-minute quota as long quota exhaustion', () => {
    expect(classifyGoogleRateLimit(error([info('RESOURCE_EXHAUSTED')]))).toEqual({ reason: 'rate-limited' });
    expect(classifyGoogleRateLimit(error([info('QUOTA_EXHAUSTED')], 'Requests per minute quota exceeded')).reason).toBe(
      'rate-limited',
    );
    expect(classifyGoogleRateLimit(error([info('QUOTA_EXHAUSTED')]))).toEqual({ reason: 'quota-exhausted' });
  });
  it('ignores invalid hints, untyped fields and oversized or malformed bodies', () => {
    for (const value of ['-3s', 'infinite', { seconds: '-1' }, { seconds: '3', nanos: 1e9 }])
      expect(classifyGoogleRateLimit(error([retry(value)]))).toEqual({ reason: 'rate-limited' });
    expect(classifyGoogleRateLimit(error([{ retryDelay: '45s' }]), '-5')).toEqual({ reason: 'rate-limited' });
    expect(classifyGoogleRateLimit('not json')).toEqual({ reason: 'rate-limited' });
    expect(classifyGoogleRateLimit(' '.repeat(16 * 1024) + error([retry('45s')]))).toEqual({ reason: 'rate-limited' });
  });
  it('bounds extreme hints and returns only fixed categories and numeric delays', () => {
    const secret = 'secret-access-token-user-prompt';
    const decision = classifyGoogleRateLimit(error([retry('9999999999999999s')], secret));
    expect(decision.retryAfterMs).toBe(31 * 24 * 3_600_000);
    expect(JSON.stringify(decision)).not.toContain(secret);
  });
  it('reads complete reset durations from bounded error messages without truncating spaced components', () => {
    expect(classifyGoogleRateLimit(error([], 'Individual quota exceeded. Resets in 1h 30m 0.5s.'))).toEqual({
      reason: 'quota-exhausted',
      retryAfterMs: 5_400_500,
    });
    expect(classifyGoogleRateLimit(error([], 'Quota exceeded. Resets in 0h 53m.')).retryAfterMs).toBe(3_180_000);
    expect(classifyGoogleRateLimit(error([], 'Resets in 1hour'))).toEqual({ reason: 'rate-limited' });
    expect(
      classifyGoogleRateLimit(JSON.stringify({ request: { prompt: 'Resets in 1h' }, error: {} })).retryAfterMs,
    ).toBeUndefined();
  });
});
