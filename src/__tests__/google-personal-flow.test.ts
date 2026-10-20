import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createModelManager } from '../modelManagement';
import { loginGoogleAccount } from '../googleOAuth';
import { GOOGLE_NATIVE_SCOPES } from '../googleNativeClient';
import * as cryptoStore from '../cryptoStore';
import {
  configureGoogleAccountPersistence,
  GOOGLE_CLOUD_CODE_USER_AGENT,
  googleAccountEndpoint,
  resetGoogleAccountState,
  type GoogleAccount,
} from '../googleAccounts';
import { runCustomModelRequest, stopCustomRequests } from '../proxy/customRequest';
import { stopCleanupInterval } from '../proxy/shared';
import type { CustomModel } from '../proxy';

vi.mock('node:https', () => ({ request: vi.fn() }));
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const servers: http.Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  stopCustomRequests();
  stopCleanupInterval();
  configureGoogleAccountPersistence(undefined);
  resetGoogleAccountState();
  vi.mocked(https.request).mockReset();
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

describe('personal Google account onboarding through real local protocol fixtures', () => {
  it('prepares two accounts, encrypts them, discovers models, refreshes and persists tokens, and rotates after 429 to generate a response', async () => {
    const trace: { host: string; path: string; method: string; authorization?: string; userAgent?: string }[] = [];
    let refreshed = 0;
    const requests: { project: string; authorization: string }[] = [];
    const upstream = await serve(async (req, res) => {
      const raw = await readBody(req);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/token') {
        const params = new URLSearchParams(raw);
        expect(params.get('client_id')).toBe('fixture-native.apps.googleusercontent.com');
        expect(params.get('client_secret')).toBe('fixture-native-secret');
        if (params.get('grant_type') === 'refresh_token') {
          refreshed++;
          expect(params.get('refresh_token')).toBe('fixture-refresh-1');
          res.end(
            JSON.stringify({
              access_token: 'fixture-refreshed-1',
              refresh_token: 'fixture-rotated-1',
              expires_in: 3600,
            }),
          );
        } else {
          expect(params.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
          const id = params.get('code');
          res.end(
            JSON.stringify({
              access_token: `fixture-access-${id}`,
              refresh_token: `fixture-refresh-${id}`,
              expires_in: 3600,
            }),
          );
        }
        return;
      }
      if (req.headers['user-agent'] !== 'antigravity-add-model') {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Cloud Code fixture requires the application User-Agent' }));
        return;
      }
      const id = req.headers.authorization?.endsWith('-2') ? '2' : '1';
      if (req.url === '/v1internal:loadCodeAssist') {
        const body = JSON.parse(raw);
        expect(body.metadata.ideName).toBe('antigravity');
        expect(body.metadata.ideType).toBe(9);
        res.end(
          JSON.stringify({ allowedTiers: [{ id: 'free-tier', isDefault: true }], paidTier: { usesGcpTos: false } }),
        );
      } else if (req.url === '/v1internal:onboardUser') {
        expect(JSON.parse(raw).tierId ?? JSON.parse(raw).tier_id).toBe('free-tier');
        res.end(JSON.stringify({ done: true, response: { cloudaicompanionProject: { id: `fixture-project-${id}` } } }));
      } else if (req.url === '/v1internal:retrieveUserQuotaSummary') {
        expect(JSON.parse(raw).project).toBe('fixture-project-1');
        res.end(JSON.stringify({ buckets: [{ bucketId: 'fixture-quota', remainingFraction: 1 }] }));
      } else if (req.url === '/v1internal:fetchAvailableModels') {
        expect(JSON.parse(raw).project).toBe('fixture-project-1');
        res.end(JSON.stringify({ models: { 'fixture-gemini': { displayName: 'Fixture Gemini' } } }));
      } else if (req.url === '/v1internal:generateContent') {
        const body = JSON.parse(raw);
        requests.push({ project: body.project, authorization: String(req.headers.authorization) });
        if (id === '1') {
          res.writeHead(429, { 'Retry-After': '60' });
          res.end(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Fixture quota exhausted' } }));
        } else {
          res.end(
            JSON.stringify({
              response: {
                candidates: [
                  { content: { role: 'model', parts: [{ text: 'PERSONAL POOL FIXTURE OK' }] }, finishReason: 'STOP' },
                ],
              },
            }),
          );
        }
      } else {
        res.writeHead(404);
        res.end('{}');
      }
    });
    vi.mocked(https.request).mockImplementation(((
      target: string | URL,
      options: http.RequestOptions,
      receive: (response: http.IncomingMessage) => void,
    ) => {
      const url = new URL(String(target));
      expect(['oauth2.googleapis.com', 'cloudcode-pa.googleapis.com', 'daily-cloudcode-pa.googleapis.com']).toContain(
        url.hostname,
      );
      const headers = options.headers as Record<string, string>;
      trace.push({
        host: url.hostname,
        path: url.pathname,
        method: options.method || 'GET',
        authorization: headers.Authorization,
        userAgent: headers['User-Agent'],
      });
      return http.request(`${upstream}${url.pathname}${url.search}`, options, receive);
    }) as typeof https.request);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'google-personal-flow-'));
    directories.push(directory);
    cryptoStore.configureCredentialDirectory(directory);
    let accountNumber = 0;
    const manager = createModelManager(
      directory,
      cryptoStore,
      async (value) => {
        const authorization = new URL(value);
        expect(authorization.origin).toBe('https://accounts.google.com');
        expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
        const callback = new URL(authorization.searchParams.get('redirect_uri')!);
        callback.search = new URLSearchParams({
          code: String(++accountNumber),
          state: authorization.searchParams.get('state')!,
        }).toString();
        expect((await fetch(callback)).status).toBe(200);
      },
      {
        loginGoogleAccount: (options, open) =>
          loginGoogleAccount(options, open, {
            resolveNativeClient: () => ({
              clientId: 'fixture-native.apps.googleusercontent.com',
              clientSecret: 'fixture-native-secret',
              scopes: [...GOOGLE_NATIVE_SCOPES],
            }),
          }),
      },
    );
    const first = await manager.googleLogin({ authMode: 'antigravity', label: 'First' });
    const second = await manager.googleLogin({ authMode: 'antigravity', label: 'Second' });
    expect(first.account).toMatchObject({
      authMode: 'antigravity',
      project: 'fixture-project-1',
      cloudCodeEndpoint: 'https://daily-cloudcode-pa.googleapis.com',
    });
    expect(JSON.stringify([first, second])).not.toMatch(/fixture-access|fixture-refresh|fixture-native-secret/);
    manager.saveModel({
      name: 'models/personal-flow',
      provider: 'google-cloudcode',
      apiUrl: 'https://cloudcode-pa.googleapis.com',
      apiFormat: 'google',
      externalModelName: 'fixture-gemini',
      maxRetries: 0,
      googlePool: { strategy: 'round-robin' },
      googleAccounts: [{ ...first.account, expiresAt: 1 }, second.account],
    });
    const storedText = fs.readFileSync(manager.store.filename, 'utf8');
    expect(storedText).toContain('local-gcm:');
    expect(storedText).not.toMatch(/fixture-access|fixture-refresh|fixture-native-secret/);
    const discovery = await manager.discoverModels({
      name: 'models/personal-flow',
      provider: 'google-cloudcode',
      apiUrl: 'https://cloudcode-pa.googleapis.com',
    });
    expect(discovery.models).toEqual([{ id: 'fixture-gemini', displayName: 'Fixture Gemini' }]);
    const quota = await manager.googleTestAccount({ modelName: 'models/personal-flow', accountId: first.account.id });
    expect(quota.quota.buckets).toEqual([{ id: 'fixture-quota', remainingFraction: 1, resetTime: undefined, scope: 'project' }]);
    expect(refreshed).toBe(1);
    const stored = manager.store.read()[0];
    const accounts = (stored.googleAccounts as GoogleAccount[]).map((account) => ({
      ...account,
      accessToken: cryptoStore.decryptString(account.accessToken!),
      refreshToken: cryptoStore.decryptString(account.refreshToken!),
      clientSecret: cryptoStore.decryptString(account.clientSecret!),
    }));
    expect(accounts[0].refreshToken).toBe('fixture-rotated-1');
    expect(accounts[0].project).toBe('fixture-project-1');
    const model = { ...stored, googleAccounts: accounts, encryptedGoogleAccounts: false } as CustomModel;
    const proxy = await serve((_req, res) => {
      void runCustomModelRequest(
        res,
        model,
        { contents: [{ role: 'user', parts: [{ text: 'fixture test' }] }] },
        false,
        [model],
      );
    });
    const response = await fetch(proxy);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('PERSONAL POOL FIXTURE OK');
    expect(requests).toEqual([
      { project: 'fixture-project-1', authorization: 'Bearer fixture-refreshed-1' },
      { project: 'fixture-project-2', authorization: 'Bearer fixture-access-2' },
    ]);
    expect(trace.find((item) => item.path.endsWith('loadCodeAssist'))?.host).toBe('cloudcode-pa.googleapis.com');
    expect(
      trace
        .filter((item) => item.host !== 'oauth2.googleapis.com')
        .every((item) => item.userAgent === GOOGLE_CLOUD_CODE_USER_AGENT),
    ).toBe(true);
    expect(
      (
        await fetch(`${upstream}/v1internal:fetchAvailableModels`, {
          method: 'POST',
          headers: { 'User-Agent': 'unidentified-fixture-client' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect(
      trace
        .filter((item) => /generateContent|fetchAvailableModels/.test(item.path))
        .every((item) => item.host === 'daily-cloudcode-pa.googleapis.com'),
    ).toBe(true);
    expect(JSON.stringify(manager.store.export())).not.toMatch(
      /fixture-access|fixture-refresh|fixture-rotated|fixture-native-secret/,
    );
  });

  it('rejects forged prepared origins and keeps explicit local test endpoints local', () => {
    expect(() => googleAccountEndpoint({ id: 'unsafe', cloudCodeEndpoint: 'https://attacker.example' })).toThrow(
      'official',
    );
    expect(
      googleAccountEndpoint(
        { id: 'a', cloudCodeEndpoint: 'https://cloudcode-pa.googleapis.com' },
        'http://127.0.0.1:1234',
      ),
    ).toBe('http://127.0.0.1:1234/');
    expect(
      googleAccountEndpoint(
        { id: 'a', cloudCodeEndpoint: 'https://cloudcode-pa.googleapis.com' },
        'https://daily-cloudcode-pa.googleapis.com',
      ),
    ).toBe('https://cloudcode-pa.googleapis.com');
  });
});
