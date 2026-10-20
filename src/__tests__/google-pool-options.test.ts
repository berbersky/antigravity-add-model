import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import {
  acquireGoogleAccount,
  fetchGoogleQuota,
  getGooglePoolStatus,
  recordGoogleAccountFailure,
  resetGoogleAccountState,
  type GoogleAccount,
} from '../googleAccounts';
import { validateCustomModel } from '../schemaValidator';

const servers: http.Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  resetGoogleAccountState();
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
});
async function quotaServer(data: unknown) {
  const server = http.createServer((_req, res) => res.end(JSON.stringify(data)));
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const account = (id: string): GoogleAccount => ({ id, accessToken: `fixture-${id}` });

describe('explicit Google pool preferences and model quotas', () => {
  it('uses upstream family rather than the local model alias for quota eligibility', async () => {
    const endpoint = await quotaServer({
      groups: [
        { name: 'Gemini', buckets: [{ bucketId: 'requests', remainingFraction: 0 }] },
        { name: 'Claude and GPT', buckets: [{ bucketId: 'requests', remainingFraction: 0.8 }] },
      ],
    });
    const entry = account('alias');
    await fetchGoogleQuota(entry, endpoint);
    const lease = await acquireGoogleAccount('models/work', [entry], {}, undefined, 'claude-sonnet', endpoint);
    lease.release();
    await expect(
      acquireGoogleAccount('models/claude-looking-alias', [entry], {}, undefined, 'gemini-pro', endpoint),
    ).rejects.toThrow(/eligible/);
  });

  it('does not infer third-party subscription eligibility from a missing quota group', async () => {
    const endpoint = await quotaServer({
      groups: [{ name: 'Gemini', buckets: [{ bucketId: 'requests', remainingFraction: 0 }] }],
    });
    const entry = account('unknown-family');
    await fetchGoogleQuota(entry, endpoint);
    const lease = await acquireGoogleAccount('models/work', [entry], {}, undefined, 'claude-sonnet', endpoint);
    lease.release();
  });

  it('honors preferred account but preserves cooldown, disable and concurrency limits', async () => {
    const entries = [account('first'), account('preferred')];
    const first = await acquireGoogleAccount('models/work', entries, {}, 'session');
    first.release();
    const preferred = await acquireGoogleAccount(
      'models/work',
      entries,
      { preferredAccountId: 'preferred', maxConcurrency: 1 },
      'session',
    );
    expect(preferred.account.id).toBe('preferred');
    const other = await acquireGoogleAccount('models/work', entries, {
      preferredAccountId: 'preferred',
      maxConcurrency: 1,
    });
    expect(other.account.id).toBe('first');
    other.release();
    preferred.release({ status: 429, retryAfterMs: 60_000 });
    const recovery = await acquireGoogleAccount('models/work', entries, { preferredAccountId: 'preferred' });
    expect(recovery.account.id).toBe('first');
    recovery.release();
    resetGoogleAccountState();
    entries[1].enabled = false;
    const disabled = await acquireGoogleAccount('models/work', entries, { preferredAccountId: 'preferred' });
    expect(disabled.account.id).toBe('first');
    disabled.release();
  });

  it.each([
    [400, 'native'],
    [400, 'lease'],
    [403, 'native'],
    [403, 'lease'],
  ] as const)('treats quota %s as a recoverable model cooldown through %s', async (status, source) => {
    const entry = account('recoverable');
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    if (source === 'native') recordGoogleAccountFailure(entry, status, 1000, 'gemini-pro', 'quota-exhausted');
    else {
      const lease = await acquireGoogleAccount('models/work', [entry], {}, undefined, 'gemini-pro');
      lease.release({ status, retryAfterMs: 1000, cooldownReason: 'quota-exhausted' });
    }
    expect(getGooglePoolStatus()[0]).toMatchObject({ status: 'cooldown', lastError: { category: 'rate-limited' } });
    const other = await acquireGoogleAccount('models/other', [entry], {}, undefined, 'gemini-flash');
    other.release();
    clock.mockReturnValue(now + 1001);
    const recovered = await acquireGoogleAccount('models/work', [entry], {}, undefined, 'gemini-pro');
    recovered.release();
    expect(getGooglePoolStatus()[0].status).toBe('ready');
  });

  it('keeps a true permission denial separate from quota recovery', async () => {
    const entry = account('forbidden');
    recordGoogleAccountFailure(entry, 403, 1, 'gemini-pro');
    expect(getGooglePoolStatus()[0]).toMatchObject({ status: 'forbidden', lastError: { category: 'access-denied' } });
    await expect(acquireGoogleAccount('models/other', [entry])).rejects.toThrow(/eligible/);
  });

  it('never sends local quota fixture credentials to live Google userinfo', async () => {
    const network = vi.spyOn(https, 'request').mockImplementation(() => {
      throw new Error('Unexpected remote call');
    });
    const endpoint = await quotaServer({ buckets: [{ bucketId: 'requests', remainingFraction: 0.5 }] });
    await fetchGoogleQuota(account('hermetic'), endpoint, { includeIdentity: true });
    expect(network).not.toHaveBeenCalled();
    const fetchUserInfo = vi.fn(async () => ({ email: 'fixture@example.test' }));
    const snapshot = await fetchGoogleQuota(account('identity'), endpoint, { includeIdentity: true, fetchUserInfo });
    expect(snapshot.email).toBe('fixture@example.test');
    expect(fetchUserInfo).toHaveBeenCalledOnce();
  });

  it('validates preference membership and opt-in type', () => {
    const model = {
      name: 'models/work',
      displayName: 'Work',
      provider: 'google-cloudcode',
      apiKey: '',
      apiUrl: 'https://daily-cloudcode-pa.googleapis.com',
      externalModelName: 'gemini-pro',
      googleAccounts: [account('first')],
      googlePool: { preferredAccountId: 'first', nativeFailoverEnabled: true },
    };
    expect(validateCustomModel(model).valid).toBe(true);
    expect(validateCustomModel({ ...model, googlePool: { preferredAccountId: 'missing' } }).valid).toBe(false);
    expect(validateCustomModel({ ...model, googlePool: { nativeFailoverEnabled: 'yes' } }).valid).toBe(false);
  });
});
