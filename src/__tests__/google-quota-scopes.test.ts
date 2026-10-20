import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import {
  acquireGoogleAccount,
  fetchGoogleQuota,
  recordGoogleAccountFailure,
  resetGoogleAccountState,
  type GoogleAccount,
} from '../googleAccounts';
import { getOfficialQuota, recordOfficialQuota, type OfficialQuotaScope } from '../proxy/shared';

const servers: http.Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  resetGoogleAccountState();
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});
async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const account = (): GoogleAccount => ({
  id: 'shared',
  clientId: 'client-a',
  accessToken: 'fixture-token',
  project: 'project-a',
});
const scope = (endpoint = 'https://daily-cloudcode-pa.googleapis.com'): OfficialQuotaScope => ({
  accountId: 'shared',
  clientId: 'client-a',
  project: 'project-a',
  endpoint,
});
const gemini = (remainingFraction: number) => ({
  buckets: [{ modelId: 'gemini-pro', remainingFraction }],
});

describe('scoped official Google quota observations', () => {
  it('isolates account, OAuth client, project and service origin and never retains arbitrary payload fields', () => {
    recordOfficialQuota({ ...gemini(0), accessToken: 'never-store', request: { prompt: 'private' } }, scope());
    expect(getOfficialQuota(scope())?.data).toEqual(gemini(0));
    for (const other of [
      { ...scope(), accountId: 'other' },
      { ...scope(), clientId: 'client-b' },
      { ...scope(), project: 'project-b' },
      { ...scope(), project: undefined },
      { ...scope(), endpoint: 'https://cloudcode-pa.googleapis.com' },
    ])
      expect(getOfficialQuota(other)).toBeUndefined();
    const copy = getOfficialQuota(scope())!;
    (copy.data.buckets as { remainingFraction: number }[])[0].remainingFraction = 1;
    expect(getOfficialQuota(scope())?.data).toEqual(gemini(0));
  });

  it('expires observations, rejects future timestamps and bounds retained account scopes', () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    recordOfficialQuota(gemini(0), scope(), now + 1);
    expect(getOfficialQuota(scope())).toBeUndefined();
    recordOfficialQuota(gemini(0), scope());
    recordOfficialQuota(gemini(1), scope(), now - 1);
    expect(getOfficialQuota(scope())?.data).toEqual(gemini(0));
    clock.mockReturnValue(now + 10 * 60_000);
    expect(getOfficialQuota(scope())).toBeUndefined();
    for (let index = 0; index < 129; index++)
      recordOfficialQuota(gemini(0.5), { ...scope(), accountId: String(index) });
    expect(getOfficialQuota({ ...scope(), accountId: '0' })).toBeUndefined();
    expect(getOfficialQuota({ ...scope(), accountId: '128' })).toBeDefined();
    resetGoogleAccountState('128');
    expect(getOfficialQuota({ ...scope(), accountId: '128' })).toBeUndefined();
  });

  it('uses fresh live data over older native observations and accepts only a genuinely newer observation', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    let observationDuringRequest = false;
    const endpoint = await serve((_req, res) => {
      if (observationDuringRequest) {
        clock.mockReturnValue(now + 2);
        recordOfficialQuota(gemini(0.9), scope(endpoint));
      }
      res.end(JSON.stringify(gemini(0.2)));
    });
    recordOfficialQuota(gemini(0.8), scope(endpoint), now - 1000);
    expect((await fetchGoogleQuota(account(), endpoint)).remainingFraction).toBe(0.2);
    observationDuringRequest = true;
    clock.mockReturnValue(now + 1);
    expect((await fetchGoogleQuota(account(), endpoint)).remainingFraction).toBe(0.9);
  });
});

describe('Google quota scopes and complementary measurements', () => {
  it('queries only the configured origin and merges labelled Gemini measurements without duplicating third-party data', async () => {
    const remote = vi.spyOn(https, 'request').mockImplementation(() => {
      throw new Error('Unexpected remote credential request');
    });
    const projects: unknown[] = [];
    const endpoint = await serve(async (req, res) => {
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      projects.push(body.project);
      expect(req.headers.authorization).toBe('Bearer fixture-token');
      res.end(
        JSON.stringify(
          body.project
            ? {
                groups: [{ name: 'Claude and GPT', buckets: [{ bucketId: 'weekly', remainingFraction: 0.3 }] }],
              }
            : {
                buckets: [
                  { modelId: 'gemini-pro', remainingFraction: 0.7 },
                  { bucketId: 'unknown', remainingFraction: 0.9 },
                ],
                groups: [{ name: 'Claude and GPT', buckets: [{ bucketId: 'weekly', remainingFraction: 0.8 }] }],
              },
        ),
      );
    });
    const snapshot = await fetchGoogleQuota(account(), endpoint);
    expect(projects).toEqual(['project-a', undefined]);
    expect(remote).not.toHaveBeenCalled();
    expect(snapshot.planTier).toBeUndefined();
    expect(snapshot.buckets).toMatchObject([
      { id: 'weekly', remainingFraction: 0.3, scope: 'project' },
      { id: 'gemini-pro', remainingFraction: 0.7, scope: 'user' },
    ]);
    expect(snapshot.buckets).toHaveLength(2);
  });

  it('preserves the primary measurement when the complementary scope is unsupported', async () => {
    const endpoint = await serve(async (req, res) => {
      let text = '';
      for await (const chunk of req) text += chunk;
      const project = JSON.parse(text).project;
      res.writeHead(project ? 200 : 403);
      res.end(
        JSON.stringify(
          project
            ? {
                groups: [{ name: 'Claude', buckets: [{ bucketId: 'weekly', remainingFraction: 0.4 }] }],
              }
            : { error: { message: 'unsupported scope', buckets: [{ modelId: 'gemini-pro', remainingFraction: 1 }] } },
        ),
      );
    });
    const snapshot = await fetchGoogleQuota(account(), endpoint);
    expect(snapshot.buckets).toHaveLength(1);
    expect(snapshot.remainingFraction).toBe(0.4);
  });

  it('does not borrow exhausted measurements or cooldowns from another project or service', async () => {
    const endpoint = await serve((_req, res) => res.end(JSON.stringify(gemini(0))));
    const otherEndpoint = await serve((_req, res) => res.end(JSON.stringify(gemini(1))));
    const entry = account();
    await fetchGoogleQuota(entry, endpoint);
    await expect(acquireGoogleAccount('local', [entry], {}, undefined, 'gemini-pro', endpoint)).rejects.toThrow(
      /eligible/,
    );
    const otherProject = { ...entry, project: 'project-b' };
    const allowed = await acquireGoogleAccount('local', [otherProject], {}, undefined, 'gemini-pro', endpoint);
    allowed.release();
    const otherService = await acquireGoogleAccount('local', [entry], {}, undefined, 'gemini-pro', otherEndpoint);
    otherService.release();
    recordGoogleAccountFailure(entry, 400, 60_000, 'claude-sonnet', 'quota-exhausted', endpoint);
    await expect(acquireGoogleAccount('local', [entry], {}, undefined, 'claude-sonnet', endpoint)).rejects.toThrow(
      /eligible/,
    );
    (await acquireGoogleAccount('local', [otherProject], {}, undefined, 'claude-sonnet', endpoint)).release();
    (await acquireGoogleAccount('local', [entry], {}, undefined, 'claude-sonnet', otherEndpoint)).release();
  });

  it('keeps account concurrency shared across project scopes', async () => {
    const entry = account();
    const first = await acquireGoogleAccount('local', [entry], { maxConcurrency: 1 });
    await expect(
      acquireGoogleAccount('local', [{ ...entry, project: 'project-b' }], { maxConcurrency: 1 }),
    ).rejects.toThrow(/eligible/);
    first.release();
  });

  it('cancels an in-flight quota request without continuing to another scope', async () => {
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    let requests = 0;
    const endpoint = await serve(() => {
      requests++;
      started();
    });
    const controller = new AbortController();
    const pending = fetchGoogleQuota(account(), endpoint, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ status: 499 });
    await began;
    controller.abort();
    await rejected;
    expect(requests).toBe(1);
  });
});
