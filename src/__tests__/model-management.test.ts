import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { ModelStore, normalizeModelConfig } from '../modelStore';
import { createModelManager, modelListUrl, requestJson } from '../modelManagement';
import { GoogleLoginOptions } from '../googleOAuth';
import { GoogleAccount, acquireGoogleAccount, getGooglePoolStatus, resetGoogleAccountState } from '../googleAccounts';
import { detectModelCapabilities } from '../proxy/modelUtils';

const codec = {
  encryptString: (value: string) => `test:${Buffer.from(value).toString('base64')}`,
  decryptString: (value: string) =>
    value.startsWith('test:') ? Buffer.from(value.slice(5), 'base64').toString() : value,
};
const directories: string[] = [];
const servers: http.Server[] = [];
function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-management-'));
  directories.push(directory);
  return { directory, manager: createModelManager(directory, codec, async () => {}) };
}
async function server(handler: http.RequestListener) {
  const instance = http.createServer(handler);
  servers.push(instance);
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
}
const entry = {
  name: 'models/test',
  provider: 'openai',
  apiUrl: 'https://example.test/v1',
  externalModelName: 'test',
  apiKey: 'private-key',
  customHeaders: { 'x-project': 'private-header' },
};
const googleEntry = {
  name: 'models/cloud',
  provider: 'google-cloudcode',
  apiUrl: 'https://daily-cloudcode-pa.googleapis.com',
  externalModelName: 'gemini-test',
  apiKey: '',
};
describe('Google fleet account actions', () => {
  it('preserves live concurrency and cooldown state when preferring or editing pool options', async () => {
    resetGoogleAccountState();
    const { manager } = setup();
    const account = { id: 'busy-account', accessToken: 'valid-fixture-token', expiresAt: Date.now() + 3600000 };
    manager.saveModel({ ...googleEntry, googleAccounts: [account], googlePool: { maxConcurrency: 1 } });
    const lease = await acquireGoogleAccount(googleEntry.name, [account], { maxConcurrency: 1 });
    manager.googleSelectAccount({ modelName: googleEntry.name, accountId: account.id });
    manager.saveModel({ ...manager.store.list()[0], googlePool: { preferredAccountId: account.id, maxConcurrency: 1, strategy: 'adaptive' } });
    expect(getGooglePoolStatus().find(value => value.id === account.id)?.inFlight).toBe(1);
    await expect(acquireGoogleAccount(googleEntry.name, [account], { maxConcurrency: 1 })).rejects.toThrow(/eligible/);
    lease.release({ status: 429, retryAfterMs: 60000 });
    manager.googleSelectAccount({ modelName: googleEntry.name, accountId: account.id });
    await expect(acquireGoogleAccount(googleEntry.name, [account], { preferredAccountId: account.id })).rejects.toThrow(/eligible/);
    resetGoogleAccountState();
  });
  it('reconnects the selected pool using new pending tokens and preserves other pools', async () => {
    const { directory } = setup();
    const fresh = { id: 'new-login-id', email: 'same@example.com', label: 'same@example.com', accessToken: 'new-access', refreshToken: 'new-refresh', clientId: 'fixture.apps.googleusercontent.com', expiresAt: Date.now() + 3600000 };
    const manager = createModelManager(directory, codec, async () => {}, { loginGoogleAccount: async () => fresh });
    for (const name of ['models/first', 'models/second']) manager.saveModel({ ...googleEntry, name, customHeaders: { 'X-Private': 'keep-secret' }, googleAccounts: [
      { ...fresh, id: 'saved-id', label: 'Work account', accessToken: 'revoked-access', refreshToken: 'revoked-refresh' },
      { id: 'other', accessToken: 'other-access' },
    ] });
    const login = await manager.googleLogin({ clientId: fresh.clientId });
    expect(login.account.refreshToken).toBe('********');
    manager.googleLinkAccount({ modelName: 'models/first', accountId: login.account.id, replaceAccountId: 'saved-id' });
    for (const model of manager.store.read()) {
      const accounts = model.googleAccounts as GoogleAccount[];
      expect(accounts[0].id).toBe('saved-id');
      expect(accounts[0].label).toBe('Work account');
      expect(codec.decryptString(accounts[0].refreshToken!)).toBe(model.name === 'models/first' ? 'new-refresh' : 'revoked-refresh');
      expect(codec.decryptString(accounts[1].accessToken!)).toBe('other-access');
      expect(codec.decryptString((model.customHeaders as Record<string, string>)['X-Private'])).toBe('keep-secret');
    }
  });
  it('deduplicates matching emails and scopes preference and removal to the selected pool', async () => {
    const { directory } = setup();
    const account = { id: 'pending', email: 'SAME@example.com', accessToken: 'new-access', clientId: 'fixture.apps.googleusercontent.com', expiresAt: Date.now() + 3600000 };
    const manager = createModelManager(directory, codec, async () => {}, { loginGoogleAccount: async () => account });
    manager.saveModel({ ...googleEntry, googleAccounts: [{ id: 'saved', email: 'same@example.com', accessToken: 'old-access' }, { id: 'standby', accessToken: 'standby-token' }] });
    manager.saveModel({ ...googleEntry, name: 'models/last', googleAccounts: [{ id: 'saved', email: 'same@example.com', accessToken: 'old-access' }] });
    const login = await manager.googleLogin({ clientId: account.clientId });
    manager.googleLinkAccount({ modelName: googleEntry.name, accountId: login.account.id });
    expect((manager.store.read()[0].googleAccounts as GoogleAccount[])).toHaveLength(2);
    manager.googleSelectAccount({ modelName: googleEntry.name, accountId: 'saved' });
    expect((manager.store.read()[0].googlePool as { preferredAccountId: string }).preferredAccountId).toBe('saved');
    expect(manager.store.read()[1].googlePool).toBeUndefined();
    manager.googleRemoveAccount({ modelName: 'models/last', accountId: 'saved' });
    expect(manager.store.read()[1].enabled).toBe(false);
    expect((manager.store.read()[0].googleAccounts as GoogleAccount[]).some(value => value.id === 'saved')).toBe(true);
    expect(manager.store.read()[1].googleAccounts).toEqual([]);
    expect((manager.store.read()[1].googlePool as { preferredAccountId?: string }).preferredAccountId).toBeUndefined();
  });
  it('does not partially write a fleet link when one pool exceeds its account limit', async () => {
    const { directory } = setup();
    const account = { id: 'pending', accessToken: 'new-access', clientId: 'fixture.apps.googleusercontent.com', expiresAt: Date.now() + 3600000 };
    const manager = createModelManager(directory, codec, async () => {}, { loginGoogleAccount: async () => account });
    manager.saveModel({ ...googleEntry, googleAccounts: [{ id: 'old', accessToken: 'old' }] });
    manager.saveModel({ ...googleEntry, name: 'models/full', googleAccounts: Array.from({ length: 50 }, (_, i) => ({ id: `account-${i}`, accessToken: 'token' })) });
    const before = fs.readFileSync(manager.store.filename, 'utf8');
    const login = await manager.googleLogin({ clientId: account.clientId });
    expect(() => manager.googleLinkAccount({ modelName: 'models/full', accountId: login.account.id })).toThrow(/50 accounts/);
    expect(fs.readFileSync(manager.store.filename, 'utf8')).toBe(before);
    expect(() => manager.googleLinkAccount({ modelName: googleEntry.name, accountId: 'missing-login' })).toThrow(/expired/);
    expect(() => manager.googleRemoveAccount({ modelName: googleEntry.name, accountId: 'missing' })).toThrow(/No saved/);
  });
});
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (instance) =>
        new Promise<void>((resolve) => {
          instance.close(resolve as () => void);
          instance.closeAllConnections();
        }),
    ),
  );
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('model storage and compatibility', () => {
  it('creates explicit effort variants without changing existing models or exposing secrets', () => {
    const { manager } = setup();
    manager.saveModel({ ...entry, displayName: 'Reasoner', supportsThinking: true });
    manager.saveModel({ ...entry, name: `${entry.name}-low`, externalModelName: 'keep-this' });
    const original = manager.store.read()[0];
    expect(manager.createEffortVariants(entry.name)).toEqual({ success: true, count: 3 });
    const saved = manager.store.read();
    expect(saved[0]).toEqual(original);
    expect(saved[1].externalModelName).toBe('keep-this');
    expect(saved.slice(2).map((model) => model.name)).toEqual([
      `${entry.name}-low-2`,
      `${entry.name}-medium`,
      `${entry.name}-high`,
    ]);
    expect(saved.slice(2).map((model) => model.reasoningEffort)).toEqual(['low', 'medium', 'high']);
    for (const model of saved.slice(2)) {
      expect(model.apiKey).toBe(original.apiKey);
      expect(model.customHeaders).toEqual(original.customHeaders);
      expect(model.externalModelName).toBe(entry.externalModelName);
    }
    expect(JSON.stringify(manager.store.list())).not.toContain('private-');
  });

  it('creates valid Anthropic thinking budgets and rejects unsupported or too-small configurations before writing', () => {
    const { manager } = setup();
    manager.saveModel({ ...entry, provider: 'anthropic', maxOutputTokens: 4096, contextWindow: 32000 });
    manager.createEffortVariants(entry.name);
    expect(
      manager.store
        .read()
        .slice(1)
        .map((model) => [model.thinkingBudget, model.maxOutputTokens]),
    ).toEqual([
      [1024, 4096],
      [4096, 5120],
      [8192, 9216],
    ]);
    manager.saveModel({ ...entry, supportsThinking: false });
    expect(() => manager.createEffortVariants(entry.name)).toThrow('without reasoning support');
    manager.saveModel({ ...entry, provider: 'anthropic', maxOutputTokens: 4096, contextWindow: 8192 });
    const before = manager.store.read();
    expect(() => manager.createEffortVariants(entry.name)).toThrow('context window is too small');
    expect(manager.store.read()).toEqual(before);
  });

  it('imports DeepSeek input modalities and preserves negative metadata over name heuristics', async () => {
    const url = await server((_req, res) => {
      res.end(
        JSON.stringify({
          data: [
            { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', input_modalities: ['text', 'image'] },
            { id: 'deepseek-v4-pro', input_modalities: ['text'] },
            { id: 'deepseek-vl2', input_modalities: ['text'], architecture: { input_modalities: ['text', 'image'] } },
            { id: 'deepseek-ai/Janus-Pro-7B', input_modalities: ['text', 'image'], supportsVision: false },
            { id: 'unknown-image-model', input_modalities: ['Text', 'Image'] },
            { id: 'deepseek-unknown' },
          ],
        }),
      );
    });
    const { manager } = setup();
    const { models } = await manager.discoverModels({ provider: 'deepseek', apiUrl: url, apiKey: 'test-key' });
    expect(models.map((model) => model.supportsVision)).toEqual([true, false, false, false, true, undefined]);
    for (const model of models) {
      expect(detectModelCapabilities({ ...model, name: model.id, provider: 'deepseek' }).supportsImages).toBe(
        model.supportsVision ?? false,
      );
    }
  });

  it('encrypts preserved legacy plaintext secrets when a masked model is saved', () => {
    const { manager } = setup();
    fs.writeFileSync(manager.store.filename, JSON.stringify({ models: [entry] }));
    manager.saveModel(manager.store.list()[0]);
    expect(fs.readFileSync(manager.store.filename, 'utf8')).not.toContain('private-');
    const stored = manager.store.read()[0];
    expect(codec.decryptString(stored.apiKey!)).toBe('private-key');
    expect(codec.decryptString((stored.customHeaders as Record<string, string>)['x-project'])).toBe('private-header');
  });

  it('requires fresh secrets before saving or discovering at a different provider origin', async () => {
    const { manager } = setup();
    let calls = 0;
    const destination = await server((_req, res) => {
      calls++;
      res.end('{"data":[]}');
    });
    manager.saveModel(entry);
    const masked = manager.store.list()[0];
    expect(() => manager.saveModel({ ...masked, apiUrl: destination })).toThrow('fresh credentials');
    await expect(
      manager.discoverModels({ name: entry.name, provider: entry.provider, apiUrl: destination }),
    ).rejects.toThrow('fresh credentials');
    await expect(manager.discoverModels({ ...masked, apiUrl: destination })).rejects.toThrow('fresh credentials');
    await expect(
      manager.discoverModels({ name: entry.name, provider: entry.provider, apiUrl: destination, apiKey: 'fresh-key' }),
    ).rejects.toThrow('fresh credentials');
    await expect(
      manager.discoverModels({
        name: entry.name,
        provider: entry.provider,
        apiUrl: destination,
        apiKey: 'fresh-key',
        customHeaders: {},
      }),
    ).resolves.toMatchObject({ success: true });
    expect(calls).toBe(1);
  });

  it('discovers and verifies Cloud Code model metadata through the selected OAuth account', async () => {
    const { manager } = setup();
    const destination = await server(async (req, res) => {
      expect(req.url).toBe('/v1internal:fetchAvailableModels');
      expect(req.headers.authorization).toBe('Bearer private-access');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ project: 'fixture-project' });
      res.end(JSON.stringify({ models: { 'gemini-test': { displayName: 'Fixture Gemini' } } }));
    });
    manager.saveModel({
      ...googleEntry,
      apiUrl: destination,
      googleProject: 'fixture-project',
      googleAccounts: [{ id: 'a', accessToken: 'private-access', expiresAt: Date.now() + 3600000 }],
    });
    const listed = manager.store.list()[0];
    const result = await manager.discoverModels(listed);
    expect(result.models).toEqual([{ id: 'gemini-test', displayName: 'Fixture Gemini' }]);
    await expect(manager.testModel(listed)).resolves.toMatchObject({ success: true });
  });

  it('tests account quota at the saved model endpoint instead of the default endpoint', async () => {
    const { manager } = setup();
    let requests = 0;
    const endpoint = await server(async (req, res) => {
      requests++;
      expect(req.url).toBe('/v1internal:retrieveUserQuotaSummary');
      expect(req.headers.authorization).toBe('Bearer quota-fixture-access');
      res.end(JSON.stringify({ buckets: [{ bucketId: 'fixture', remainingFraction: 0.75 }] }));
    });
    manager.saveModel({
      ...googleEntry,
      apiUrl: endpoint,
      googleAccounts: [{ id: 'quota-endpoint', accessToken: 'quota-fixture-access', expiresAt: Date.now() + 3600000 }],
    });
    const result = await manager.googleTestAccount({ modelName: googleEntry.name, accountId: 'quota-endpoint' });
    expect(requests).toBe(1);
    expect(result.quota.buckets).toEqual([{ id: 'fixture', remainingFraction: 0.75, resetTime: undefined, scope: 'user' }]);
  });

  it('does not let a stale refresh overwrite credentials edited while a test was in flight', async () => {
    const { directory } = setup();
    let finish!: (account: GoogleAccount) => void;
    const manager = createModelManager(directory, codec, async () => {}, {
      loginGoogleAccount: async () => {
        throw new Error('Not used');
      },
      refreshGoogleAccount: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      fetchGoogleQuota: async (account) => ({ accountId: account.id, checkedAt: 123, buckets: [] }),
      now: Date.now,
    });
    manager.saveModel({ ...googleEntry, googleAccounts: [{ id: 'a', refreshToken: 'old-refresh' }] });
    const testing = manager.googleTestAccount({ modelName: googleEntry.name, accountId: 'a' });
    manager.saveModel({ ...googleEntry, googleAccounts: [{ id: 'a', refreshToken: 'new-refresh' }] });
    finish({ id: 'a', refreshToken: 'stale-refresh', accessToken: 'stale-access' });
    await testing;
    const stored = (manager.store.read()[0].googleAccounts as GoogleAccount[])[0];
    expect(codec.decryptString(stored.refreshToken!)).toBe('new-refresh');
    expect(stored.accessToken).toBeUndefined();
  });
  it('encrypts nested account credentials, preserves masked edits and excludes them from exports', () => {
    const { manager } = setup();
    manager.saveModel({
      ...googleEntry,
      googleAccounts: [
        { id: 'a', accessToken: 'private-access', refreshToken: 'private-refresh', clientSecret: 'private-client' },
      ],
    });
    expect(fs.readFileSync(manager.store.filename, 'utf8')).not.toContain('private-');
    const masked = manager.store.list()[0];
    expect((masked.googleAccounts as GoogleAccount[])[0]).toMatchObject({
      accessToken: '********',
      refreshToken: '********',
      clientSecret: '********',
    });
    manager.saveModel({ ...masked, displayName: 'Edited' });
    const account = (manager.store.read()[0].googleAccounts as GoogleAccount[])[0];
    expect(codec.decryptString(account.refreshToken!)).toBe('private-refresh');
    expect((manager.store.export().models[0].googleAccounts as GoogleAccount[])[0]).toEqual({ id: 'a' });
    expect(() => manager.saveModel({ ...googleEntry, googleAccounts: [{ id: 'a' }, { id: 'a' }] })).toThrow(
      /unique|Duplicate/,
    );
  });

  it('keeps login tokens in the main process and expires unsaved masked accounts', async () => {
    const { directory } = setup();
    let now = 1000;
    const account = {
      id: 'pending',
      accessToken: 'private-access',
      refreshToken: 'private-refresh',
      expiresAt: 1000000,
      clientId: 'fixture.apps.googleusercontent.com',
    };
    const manager = createModelManager(directory, codec, async () => {}, {
      loginGoogleAccount: async () => account,
      refreshGoogleAccount: async (value) => value,
      fetchGoogleQuota: async (value) => ({ accountId: value.id, checkedAt: now, buckets: [] }),
      now: () => now,
    });
    const login = await manager.googleLogin({ clientId: account.clientId });
    expect(JSON.stringify(login)).not.toContain('private-');
    expect(fs.existsSync(manager.store.filename)).toBe(false);
    await expect(manager.googleTestAccount({ account: login.account })).resolves.toMatchObject({ success: true });
    manager.saveModel({ ...googleEntry, googleAccounts: [login.account] });
    expect(codec.decryptString((manager.store.read()[0].googleAccounts as GoogleAccount[])[0].refreshToken!)).toBe(
      'private-refresh',
    );
    const next = await manager.googleLogin({ clientId: account.clientId });
    now += 600001;
    expect(() => manager.saveModel({ ...googleEntry, name: 'models/expired', googleAccounts: [next.account] })).toThrow(
      'expired',
    );
  });

  it('saves every selected catalog model and can refetch using the same masked Google login', async () => {
    const { directory } = setup();
    let requests = 0;
    const destination = await server(async (req, res) => {
      requests++;
      expect(req.url).toBe('/v1internal:fetchAvailableModels');
      expect(req.headers.authorization).toBe('Bearer private-batch-access');
      res.end(JSON.stringify({ models: { 'gemini-first': {}, 'gemini-second': {}, 'gemini-third': {} } }));
    });
    const account = {
      id: 'batch-login',
      clientId: 'fixture.apps.googleusercontent.com',
      accessToken: 'private-batch-access',
      refreshToken: 'private-batch-refresh',
      clientSecret: 'private-batch-client',
      expiresAt: Date.now() + 3600000,
    };
    const manager = createModelManager(directory, codec, async () => {}, {
      loginGoogleAccount: async () => account,
      refreshGoogleAccount: async (value) => value,
    });
    const login = await manager.googleLogin({ clientId: account.clientId });
    const probe = { provider: googleEntry.provider, apiUrl: destination, googleAccounts: [login.account] };
    const catalog = await manager.discoverModels(probe);
    for (const model of catalog.models) {
      manager.saveModel({
        ...googleEntry,
        ...probe,
        name: `models/${model.id}`,
        externalModelName: model.id,
      });
    }
    expect(manager.store.read().map((model) => model.externalModelName)).toEqual([
      'gemini-first',
      'gemini-second',
      'gemini-third',
    ]);
    await expect(manager.discoverModels(probe)).resolves.toEqual(catalog);
    expect(requests).toBe(2);
    for (const model of manager.store.read()) {
      expect(model.encryptedGoogleAccounts).toBe(true);
      const saved = (model.googleAccounts as GoogleAccount[])[0];
      for (const field of ['accessToken', 'refreshToken', 'clientSecret'] as const)
        expect(codec.decryptString(saved[field]!)).toBe(account[field]);
    }
    expect(fs.readFileSync(manager.store.filename, 'utf8')).not.toContain('private-batch-');
    expect(JSON.stringify(login)).not.toContain('private-batch-');
    expect(JSON.stringify(manager.store.list())).not.toContain('private-batch-');
  });

  it('does not extend the login expiry on batch saves or borrow credentials from saved models after expiry', async () => {
    const { directory } = setup();
    let now = 1000;
    const account = {
      id: 'expiring-batch',
      clientId: 'fixture.apps.googleusercontent.com',
      accessToken: 'private-expiring-access',
      refreshToken: 'private-expiring-refresh',
    };
    const manager = createModelManager(directory, codec, async () => {}, {
      loginGoogleAccount: async () => account,
      now: () => now,
    });
    const login = await manager.googleLogin({ clientId: account.clientId });
    const expiresAt = now + 10 * 60 * 1000;
    now = expiresAt - 2;
    manager.saveModel({ ...googleEntry, googleAccounts: [login.account] });
    now++;
    manager.saveModel({ ...googleEntry, name: 'models/second', googleAccounts: [login.account] });
    now = expiresAt;
    expect(() =>
      manager.saveModel({ ...googleEntry, name: 'models/expired-third', googleAccounts: [login.account] }),
    ).toThrow('Account credentials expired or unavailable');
    expect(manager.store.read()).toHaveLength(2);
    // Editing an existing model still resolves only that model's saved credentials.
    const saved = manager.store.list()[0];
    manager.saveModel({ ...saved, displayName: 'Edited after login expiry' });
    expect(manager.store.list()[0].displayName).toBe('Edited after login expiry');
  });

  it('prefers a saved model\'s edited credentials over the retained pending login', async () => {
    const { directory } = setup();
    const account = {
      id: 'edited-batch',
      clientId: 'fixture.apps.googleusercontent.com',
      accessToken: 'private-original-access',
      refreshToken: 'private-original-refresh',
    };
    const manager = createModelManager(directory, codec, async () => {}, {
      loginGoogleAccount: async () => account,
    });
    const login = await manager.googleLogin({ clientId: account.clientId });
    manager.saveModel({ ...googleEntry, googleAccounts: [login.account] });
    manager.saveModel({
      ...googleEntry,
      googleAccounts: [{ ...account, accessToken: 'private-edited-access', refreshToken: 'private-edited-refresh' }],
    });
    manager.saveModel({ ...manager.store.list()[0], displayName: 'Edited label' });
    const saved = (manager.store.read()[0].googleAccounts as GoogleAccount[])[0];
    expect(codec.decryptString(saved.accessToken!)).toBe('private-edited-access');
    expect(codec.decryptString(saved.refreshToken!)).toBe('private-edited-refresh');
  });

  it('resolves saved masked tokens for quota checks without saving unsaved edits', async () => {
    const { directory } = setup();
    let received: GoogleAccount | undefined;
    const manager = createModelManager(directory, codec, async () => {}, {
      loginGoogleAccount: async () => {
        throw new Error('Not used');
      },
      refreshGoogleAccount: async (account) => {
        received = account;
        return { ...account, accessToken: 'private-fresh', expiresAt: 999999 };
      },
      fetchGoogleQuota: async (account) => ({ accountId: account.id, checkedAt: 123, buckets: [] }),
      now: Date.now,
    });
    manager.saveModel({
      ...googleEntry,
      googleAccounts: [{ id: 'saved', accessToken: 'private-access', refreshToken: 'private-refresh' }],
    });
    const masked = (manager.store.list()[0].googleAccounts as GoogleAccount[])[0];
    await manager.googleTestAccount({ modelName: googleEntry.name, account: { ...masked, label: 'Unsaved' } });
    expect(received).toMatchObject({
      accessToken: 'private-access',
      refreshToken: 'private-refresh',
      label: 'Unsaved',
    });
    expect((manager.store.read()[0].googleAccounts as GoogleAccount[])[0].label).toBeUndefined();
    await manager.googleTestAccount({ modelName: googleEntry.name, accountId: 'saved' });
    expect(codec.decryptString((manager.store.read()[0].googleAccounts as GoogleAccount[])[0].accessToken!)).toBe(
      'private-fresh',
    );
  });

  it('prepares native login before returning a masked pending account and saves its project and encrypted credentials', async () => {
    const { directory } = setup();
    const native = {
      id: 'native-pending',
      authMode: 'antigravity' as const,
      clientId: 'native.apps.googleusercontent.com',
      clientSecret: 'private-native-client',
      accessToken: 'private-native-access',
      refreshToken: 'private-native-refresh',
      expiresAt: Date.now() + 3600000,
    };
    const login = vi.fn(async () => native);
    const prepare = vi.fn(async (account: GoogleAccount) => ({
      ...account,
      project: 'prepared-native-project',
      cloudCodeEndpoint: 'https://daily-cloudcode-pa.googleapis.com',
    }));
    const manager = createModelManager(directory, codec, async () => {}, {
      loginGoogleAccount: login,
      prepareGoogleAccount: prepare,
    });
    const result = await manager.googleLogin({ authMode: 'antigravity', label: 'Personal' });
    expect(login).toHaveBeenCalledWith(
      expect.objectContaining({ authMode: 'antigravity', signal: expect.any(AbortSignal) }),
      expect.any(Function),
    );
    expect(prepare).toHaveBeenCalledWith(
      native,
      expect.objectContaining({ allowOnboard: true, signal: expect.any(AbortSignal) }),
    );
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(result.account).toMatchObject({
      authMode: 'antigravity',
      project: 'prepared-native-project',
      cloudCodeEndpoint: 'https://daily-cloudcode-pa.googleapis.com',
      accessToken: '********',
      refreshToken: '********',
      clientSecret: '********',
    });
    expect(fs.existsSync(manager.store.filename)).toBe(false);
    manager.saveModel({ ...googleEntry, googleAccounts: [result.account] });
    const stored = (manager.store.read()[0].googleAccounts as GoogleAccount[])[0];
    expect(stored).toMatchObject({
      authMode: 'antigravity',
      project: 'prepared-native-project',
      cloudCodeEndpoint: 'https://daily-cloudcode-pa.googleapis.com',
    });
    for (const field of ['accessToken', 'refreshToken', 'clientSecret'] as const)
      expect(codec.decryptString(stored[field]!)).toBe(native[field]);
    expect(fs.readFileSync(manager.store.filename, 'utf8')).not.toContain('private-');
  });

  it('does not enroll legacy custom OAuth logins automatically', async () => {
    const { directory } = setup();
    const prepare = vi.fn();
    const manager = createModelManager(directory, codec, async () => {}, {
      loginGoogleAccount: async () => ({
        id: 'custom-pending',
        clientId: 'custom.apps.googleusercontent.com',
        accessToken: 'private-custom-access',
        expiresAt: Date.now() + 3600000,
      }),
      prepareGoogleAccount: prepare,
    });
    await manager.googleLogin({ clientId: 'custom.apps.googleusercontent.com' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each([
    ['accessToken', 'private-edited-access'],
    ['refreshToken', 'private-edited-refresh'],
    ['clientSecret', 'private-edited-secret'],
    ['clientId', 'edited.apps.googleusercontent.com'],
    ['project', 'edited-project'],
    ['authMode', 'custom'],
    ['cloudCodeEndpoint', 'https://cloudcode-pa.googleapis.com'],
  ])('refuses unsaved %s changes before refresh or preparation can start', async (field, value) => {
    const { directory } = setup();
    const refresh = vi.fn();
    const prepare = vi.fn();
    const manager = createModelManager(directory, codec, async () => {}, {
      refreshGoogleAccount: refresh,
      prepareGoogleAccount: prepare,
    });
    manager.saveModel({
      ...googleEntry,
      googleAccounts: [
        {
          id: 'save-first',
          clientId: 'original.apps.googleusercontent.com',
          clientSecret: 'private-original-secret',
          accessToken: 'private-original-access',
          refreshToken: 'private-original-refresh',
          project: 'original-project',
          authMode: 'antigravity',
          cloudCodeEndpoint: 'https://daily-cloudcode-pa.googleapis.com',
        },
      ],
    });
    const before = fs.readFileSync(manager.store.filename, 'utf8');
    const masked = (manager.store.list()[0].googleAccounts as GoogleAccount[])[0];
    await expect(
      manager.googlePrepareAccount({
        modelName: googleEntry.name,
        account: { ...masked, [field]: value },
        allowOnboard: true,
      }),
    ).rejects.toThrow('Save your edited account');
    expect(refresh).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(fs.readFileSync(manager.store.filename, 'utf8')).toBe(before);
  });

  it('prepares edited credentials after Save and retains the fresh credentials through a masked resave', async () => {
    const { directory } = setup();
    const prepare = vi.fn(async (account: GoogleAccount) => ({
      ...account,
      project: 'new-prepared-project',
      cloudCodeEndpoint: 'https://daily-cloudcode-pa.googleapis.com',
    }));
    const manager = createModelManager(directory, codec, async () => {}, {
      refreshGoogleAccount: async (account) => account,
      prepareGoogleAccount: prepare,
    });
    manager.saveModel({
      ...googleEntry,
      googleAccounts: [
        {
          id: 'edited-saved',
          clientId: 'original.apps.googleusercontent.com',
          clientSecret: 'private-original-secret',
          accessToken: 'private-original-access',
          refreshToken: 'private-original-refresh',
        },
      ],
    });
    const edited: GoogleAccount = {
      id: 'edited-saved',
      clientId: 'edited.apps.googleusercontent.com',
      clientSecret: 'private-edited-secret',
      accessToken: 'private-edited-access',
      refreshToken: 'private-edited-refresh',
      authMode: 'antigravity',
    };
    manager.saveModel({ ...googleEntry, googleAccounts: [edited] });
    const result = await manager.googlePrepareAccount({
      modelName: googleEntry.name,
      accountId: edited.id,
      allowOnboard: true,
    });
    expect(prepare).toHaveBeenCalledWith(edited, expect.objectContaining({ allowOnboard: true }));
    expect(JSON.stringify(result)).not.toContain('private-');
    manager.saveModel({ ...googleEntry, googleAccounts: [result.account] });
    const stored = (manager.store.read()[0].googleAccounts as GoogleAccount[])[0];
    expect(stored).toMatchObject({
      project: 'new-prepared-project',
      authMode: 'antigravity',
      clientId: edited.clientId,
      cloudCodeEndpoint: 'https://daily-cloudcode-pa.googleapis.com',
    });
    for (const field of ['accessToken', 'refreshToken', 'clientSecret'] as const)
      expect(codec.decryptString(stored[field]!)).toBe(edited[field]);
  });

  it.each([
    ['project', 'concurrent-project'],
    ['cloudCodeEndpoint', 'https://cloudcode-pa.googleapis.com'],
    ['authMode', 'custom'],
    ['clientId', 'concurrent.apps.googleusercontent.com'],
    ['clientSecret', 'private-concurrent-secret'],
    ['accessToken', 'private-concurrent-access'],
    ['refreshToken', 'private-concurrent-refresh'],
  ])('does not overwrite a saved %s edit with a stale preparation result', async (field, value) => {
    const { directory } = setup();
    let finish!: (account: GoogleAccount & { project: string; cloudCodeEndpoint: string }) => void;
    let started!: () => void;
    const preparing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const manager = createModelManager(directory, codec, async () => {}, {
      refreshGoogleAccount: async (account) => account,
      prepareGoogleAccount: () =>
        new Promise((resolve) => {
          finish = resolve;
          started();
        }),
    });
    const original: GoogleAccount = {
      id: 'concurrent-preparation',
      clientId: 'original.apps.googleusercontent.com',
      clientSecret: 'private-original-secret',
      accessToken: 'private-original-access',
      refreshToken: 'private-original-refresh',
      project: 'original-project',
      authMode: 'antigravity',
      cloudCodeEndpoint: 'https://daily-cloudcode-pa.googleapis.com',
    };
    manager.saveModel({ ...googleEntry, googleAccounts: [original] });
    const result = manager.googlePrepareAccount({
      modelName: googleEntry.name,
      accountId: original.id,
      allowOnboard: true,
    });
    await preparing;
    manager.saveModel({ ...googleEntry, googleAccounts: [{ ...original, [field]: value }] });
    const savedAfterEdit = fs.readFileSync(manager.store.filename, 'utf8');
    finish({
      ...original,
      accessToken: 'private-stale-access',
      project: 'stale-prepared-project',
      cloudCodeEndpoint: 'https://daily-cloudcode-pa.googleapis.com',
    });
    await expect(result).rejects.toThrow('changed while preparation was running');
    expect(fs.readFileSync(manager.store.filename, 'utf8')).toBe(savedAfterEdit);
    // A failed operation must not leave stale credentials reusable through the pending-account path.
    expect(() =>
      manager.saveModel({
        ...googleEntry,
        name: 'models/no-stale-pending',
        googleAccounts: [{ id: original.id, accessToken: '********' }],
      }),
    ).toThrow('expired or unavailable');
  });

  it.each(['failure', 'cancel-preparation', 'cancel-refresh', 'success'] as const)(
    'retains a saved account’s rotated token when account preparation ends with %s',
    async (outcome) => {
      const { directory } = setup();
      const original: GoogleAccount = {
        id: 'rotating-preparation',
        clientId: 'fixture.apps.googleusercontent.com',
        clientSecret: 'private-client-secret',
        accessToken: 'private-old-access',
        refreshToken: 'private-old-refresh',
        expiresAt: 1,
        project: 'original-project',
        authMode: 'antigravity',
        cloudCodeEndpoint: 'https://cloudcode-pa.googleapis.com',
      };
      const rotated: GoogleAccount = {
        ...original,
        accessToken: 'private-rotated-access',
        refreshToken: 'private-rotated-refresh',
        expiresAt: Date.now() + 3600000,
      };
      let finishRefresh!: (account: GoogleAccount) => void;
      let finishPreparation!: (account: GoogleAccount & { project: string; cloudCodeEndpoint: string }) => void;
      let failPreparation!: (error: Error) => void;
      let started!: () => void;
      const preparing = new Promise<void>((resolve) => {
        started = resolve;
      });
      const prepare = vi.fn(
        () =>
          new Promise<GoogleAccount & { project: string; cloudCodeEndpoint: string }>((resolve, reject) => {
            finishPreparation = resolve;
            failPreparation = reject;
            started();
          }),
      );
      const manager = createModelManager(directory, codec, async () => {}, {
        refreshGoogleAccount: () =>
          new Promise((resolve) => {
            finishRefresh = resolve;
          }),
        prepareGoogleAccount: prepare,
      });
      manager.saveModel({ ...googleEntry, googleAccounts: [original] });
      const result = manager.googlePrepareAccount({
        modelName: googleEntry.name,
        accountId: original.id,
        allowOnboard: true,
      });
      if (outcome === 'cancel-refresh') manager.googleLoginCancel();
      finishRefresh(rotated);
      if (outcome !== 'cancel-refresh') {
        await preparing;
        // Rotation is durable before the next Google operation has returned.
        const duringPreparation = (manager.store.read()[0].googleAccounts as GoogleAccount[])[0];
        expect(codec.decryptString(duringPreparation.refreshToken!)).toBe(rotated.refreshToken);
        expect(duringPreparation.project).toBe(original.project);
        if (outcome === 'failure') failPreparation(new Error('Preparation fixture failed'));
        else {
          if (outcome === 'cancel-preparation') manager.googleLoginCancel();
          finishPreparation({
            ...rotated,
            project: 'new-prepared-project',
            cloudCodeEndpoint: 'https://daily-cloudcode-pa.googleapis.com',
          });
        }
      }
      if (outcome === 'success') await expect(result).resolves.toMatchObject({ success: true });
      else await expect(result).rejects.toThrow(outcome === 'failure' ? 'Preparation fixture failed' : /cancelled/i);
      const stored = (manager.store.read()[0].googleAccounts as GoogleAccount[])[0];
      expect(codec.decryptString(stored.refreshToken!)).toBe(rotated.refreshToken);
      expect(codec.decryptString(stored.accessToken!)).toBe(rotated.accessToken);
      expect(stored.expiresAt).toBe(rotated.expiresAt);
      expect(stored.project).toBe(outcome === 'success' ? 'new-prepared-project' : original.project);
      expect(stored.cloudCodeEndpoint).toBe(
        outcome === 'success' ? 'https://daily-cloudcode-pa.googleapis.com' : original.cloudCodeEndpoint,
      );
      expect(fs.readFileSync(manager.store.filename, 'utf8')).not.toContain('private-');
      if (outcome === 'cancel-refresh') expect(prepare).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['clientId', 'edited.apps.googleusercontent.com'],
    ['clientSecret', 'private-edited-secret'],
    ['accessToken', 'private-edited-access'],
    ['refreshToken', 'private-edited-refresh'],
  ])('does not persist a stale rotation over a %s edit made during refresh', async (field, value) => {
    const { directory } = setup();
    let finishRefresh!: (account: GoogleAccount) => void;
    const prepare = vi.fn();
    const manager = createModelManager(directory, codec, async () => {}, {
      refreshGoogleAccount: () =>
        new Promise((resolve) => {
          finishRefresh = resolve;
        }),
      prepareGoogleAccount: prepare,
    });
    const original: GoogleAccount = {
      id: 'concurrent-refresh-prepare',
      clientId: 'original.apps.googleusercontent.com',
      clientSecret: 'private-original-secret',
      accessToken: 'private-original-access',
      refreshToken: 'private-original-refresh',
      expiresAt: 1,
    };
    manager.saveModel({ ...googleEntry, googleAccounts: [original] });
    const result = manager.googlePrepareAccount({
      modelName: googleEntry.name,
      accountId: original.id,
      allowOnboard: true,
    });
    manager.saveModel({ ...googleEntry, googleAccounts: [{ ...original, [field]: value }] });
    const afterEdit = fs.readFileSync(manager.store.filename, 'utf8');
    finishRefresh({
      ...original,
      accessToken: 'private-stale-rotated-access',
      refreshToken: 'private-stale-rotated-refresh',
      expiresAt: Date.now() + 3600000,
    });
    await expect(result).rejects.toThrow('changed while preparation was running');
    expect(prepare).not.toHaveBeenCalled();
    expect(fs.readFileSync(manager.store.filename, 'utf8')).toBe(afterEdit);
  });

  it('retains a valid rotation but preserves a project edited during refresh and stops preparation', async () => {
    const { directory } = setup();
    let finishRefresh!: (account: GoogleAccount) => void;
    const prepare = vi.fn();
    const manager = createModelManager(directory, codec, async () => {}, {
      refreshGoogleAccount: () =>
        new Promise((resolve) => {
          finishRefresh = resolve;
        }),
      prepareGoogleAccount: prepare,
    });
    const original: GoogleAccount = {
      id: 'refresh-project-edit',
      clientId: 'original.apps.googleusercontent.com',
      accessToken: 'private-original-access',
      refreshToken: 'private-original-refresh',
      expiresAt: 1,
      project: 'original-project',
    };
    manager.saveModel({ ...googleEntry, googleAccounts: [original] });
    const result = manager.googlePrepareAccount({
      modelName: googleEntry.name,
      accountId: original.id,
      allowOnboard: true,
    });
    manager.saveModel({ ...googleEntry, googleAccounts: [{ ...original, project: 'edited-project' }] });
    finishRefresh({
      ...original,
      accessToken: 'private-rotated-access',
      refreshToken: 'private-rotated-refresh',
      expiresAt: Date.now() + 3600000,
    });
    await expect(result).rejects.toThrow('changed while preparation was running');
    expect(prepare).not.toHaveBeenCalled();
    const stored = (manager.store.read()[0].googleAccounts as GoogleAccount[])[0];
    expect(stored.project).toBe('edited-project');
    expect(codec.decryptString(stored.refreshToken!)).toBe('private-rotated-refresh');
  });

  it('does not create a saved or pending account from an unsuccessful unsaved preparation refresh', async () => {
    const { directory } = setup();
    const manager = createModelManager(directory, codec, async () => {}, {
      refreshGoogleAccount: async (account) => ({
        ...account,
        accessToken: 'private-new-access',
        refreshToken: 'private-new-refresh',
      }),
      prepareGoogleAccount: async () => {
        throw new Error('Preparation fixture failed');
      },
    });
    await expect(
      manager.googlePrepareAccount({
        account: {
          id: 'never-saved',
          clientId: 'fixture.apps.googleusercontent.com',
          refreshToken: 'private-original-refresh',
        },
        allowOnboard: true,
      }),
    ).rejects.toThrow('Preparation fixture failed');
    expect(fs.existsSync(manager.store.filename)).toBe(false);
    expect(() =>
      manager.saveModel({ ...googleEntry, googleAccounts: [{ id: 'never-saved', refreshToken: '********' }] }),
    ).toThrow('expired or unavailable');
  });

  it.each(['login', 'prepare'] as const)(
    'discards a cancelled %s bootstrap result that completes late',
    async (operation) => {
      const { directory } = setup();
      const account = {
        id: `cancelled-${operation}`,
        clientId: 'fixture.apps.googleusercontent.com',
        accessToken: 'private-cancelled-access',
        refreshToken: 'private-cancelled-refresh',
        expiresAt: Date.now() + 3600000,
        authMode: 'antigravity' as const,
      };
      let finish!: (account: GoogleAccount & { project: string; cloudCodeEndpoint: string }) => void;
      let started!: () => void;
      let signal!: AbortSignal;
      const preparing = new Promise<void>((resolve) => {
        started = resolve;
      });
      const manager = createModelManager(directory, codec, async () => {}, {
        loginGoogleAccount: async () => account,
        refreshGoogleAccount: async (value) => value,
        prepareGoogleAccount: (_account, options) =>
          new Promise((resolve) => {
            finish = resolve;
            signal = options!.signal!;
            started();
          }),
      });
      if (operation === 'prepare') manager.saveModel({ ...googleEntry, googleAccounts: [account] });
      const before = operation === 'prepare' ? fs.readFileSync(manager.store.filename, 'utf8') : undefined;
      const result =
        operation === 'login'
          ? manager.googleLogin({ authMode: 'antigravity' })
          : manager.googlePrepareAccount({ modelName: googleEntry.name, accountId: account.id, allowOnboard: true });
      await preparing;
      manager.googleLoginCancel();
      expect(signal.aborted).toBe(true);
      finish({
        ...account,
        project: 'cancelled-project',
        cloudCodeEndpoint: 'https://daily-cloudcode-pa.googleapis.com',
      });
      await expect(result).rejects.toThrow(/cancelled/i);
      if (before) expect(fs.readFileSync(manager.store.filename, 'utf8')).toBe(before);
      else expect(fs.existsSync(manager.store.filename)).toBe(false);
      expect(() =>
        manager.saveModel({
          ...googleEntry,
          name: 'models/cancelled-result',
          googleAccounts: [{ id: account.id, accessToken: '********' }],
        }),
      ).toThrow('expired or unavailable');
    },
  );

  it('cancels an active login and rejects overlapping login attempts', async () => {
    const { directory } = setup();
    const manager = createModelManager(directory, codec, async () => {}, {
      loginGoogleAccount: (options: GoogleLoginOptions) =>
        new Promise((_resolve, reject) =>
          options.signal!.addEventListener('abort', () => reject(new Error('Cancelled'))),
        ),
      refreshGoogleAccount: async (value) => value,
      fetchGoogleQuota: async (value) => ({ accountId: value.id, checkedAt: 1, buckets: [] }),
      now: Date.now,
    });
    const result = manager.googleLogin({ clientId: 'fixture.apps.googleusercontent.com' });
    await expect(manager.googleLogin({ clientId: 'fixture.apps.googleusercontent.com' })).rejects.toThrow('already');
    manager.googleLoginCancel();
    await expect(result).rejects.toThrow('Cancelled');
  });
  it('keeps encrypted keys and headers through edits, copies, renames and export', () => {
    const { manager } = setup();
    manager.store.save(entry);
    const raw = fs.readFileSync(manager.store.filename, 'utf8');
    expect(raw).not.toContain('private-key');
    expect(raw).not.toContain('private-header');
    const listed = manager.store.list()[0];
    expect(listed.apiKey).toBe('********');
    expect(listed.customHeaders).toEqual({ 'x-project': '********' });
    manager.store.save({ ...listed, name: 'models/copy', copyFrom: entry.name });
    manager.store.save({ ...listed, name: 'models/renamed', originalName: entry.name, displayName: 'Renamed' });
    expect(manager.store.read().map((m) => m.name)).toEqual(['models/renamed', 'models/copy']);
    for (const model of manager.store.read()) expect(codec.decryptString(model.apiKey!)).toBe('private-key');
    const exported = manager.store.export();
    expect(exported.models[0]).not.toHaveProperty('apiKey');
    expect(exported.models[0]).not.toHaveProperty('customHeaders');
    expect(JSON.stringify(exported)).not.toContain('private-');
  });

  it('migrates grouped provider exports, including disabled groups and field aliases', () => {
    const payload = {
      providers: [
        {
          id: 'local',
          provider: 'ollama',
          apiUrl: 'http://localhost:11434/v1',
          enabled: false,
          models: [{ id: 'llama', supportsImages: false, extraHeaders: { 'x-id': 'hi' } }],
        },
      ],
    };
    const models = normalizeModelConfig(payload);
    expect(models[0]).toMatchObject({
      name: 'models/local-llama',
      externalModelName: 'llama',
      enabled: false,
      supportsVision: false,
      customHeaders: { 'x-id': 'hi' },
    });
    expect(models[0]).not.toHaveProperty('extraHeaders');
    expect(normalizeModelConfig(Buffer.from(JSON.stringify(payload)).toString('base64'))).toEqual(models);
  });

  it('bulk import is atomic when any model fails validation', () => {
    const { manager } = setup();
    manager.store.save(entry);
    const before = fs.readFileSync(manager.store.filename, 'utf8');
    expect(() =>
      manager.store.import({
        models: [
          { ...entry, name: 'models/new' },
          { ...entry, apiUrl: 'file:///secret' },
        ],
      }),
    ).toThrow();
    expect(fs.readFileSync(manager.store.filename, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(manager.store.filename))).not.toContain('.tmp');
  });

  it('does not overwrite malformed configuration or import duplicate names', () => {
    const { manager } = setup();
    fs.writeFileSync(manager.store.filename, '{broken');
    expect(() => manager.store.save(entry)).toThrow();
    expect(fs.readFileSync(manager.store.filename, 'utf8')).toBe('{broken');
    fs.writeFileSync(manager.store.filename, '{"models":[]}');
    expect(() => manager.store.import([entry, entry])).toThrow('Duplicate');
    expect(manager.store.list()).toEqual([]);
  });

  it('retargets fallback references on rename and removes deleted references', () => {
    const { manager } = setup();
    manager.store.save(entry);
    manager.store.save({ ...entry, name: 'models/other', fallbackModels: [entry.name] });
    manager.store.save({ ...manager.store.list()[0], originalName: entry.name, name: 'models/new' });
    expect(manager.store.read()[1].fallbackModels).toEqual(['models/new']);
    manager.store.delete('models/new');
    expect(manager.store.read()[0].fallbackModels).toEqual([]);
  });

  it('does not accept a masked or foreign encrypted key for a new model', () => {
    const { manager } = setup();
    expect(() => manager.store.save({ ...entry, apiKey: '********' })).toThrow('Enter a key');
    expect(() => manager.store.save({ ...entry, apiKey: 'enc:foreign' })).toThrow('cannot be imported');
  });
});

describe('provider discovery and saved credentials', () => {
  const workersAccount = '0123456789abcdef0123456789abcdef';
  const workersPath = `/client/v4/accounts/${workersAccount}/ai`;

  it('uses the Workers AI catalog for the preset and existing official Custom endpoints only', () => {
    const expected = `https://api.cloudflare.com${workersPath}/models/search?format=openrouter&task=Text+Generation&per_page=100&page=1`;
    expect(modelListUrl(`https://api.cloudflare.com${workersPath}/v1/chat/completions`, 'openai', 'workers-ai')).toBe(
      expected,
    );
    expect(modelListUrl(`https://api.cloudflare.com${workersPath}/v1`, 'openai', 'custom')).toBe(expected);
    expect(modelListUrl(`https://api.cloudflare.com.example${workersPath}/v1`, 'openai', 'custom')).toContain(
      '/ai/v1/models',
    );
    expect(modelListUrl(`http://api.cloudflare.com${workersPath}/v1`, 'openai', 'custom')).toContain('/ai/v1/models');
  });

  it('rejects an unfinished account URL before saving, importing, or discovering', async () => {
    const { manager } = setup();
    const template = manager.presets().find((preset) => preset.id === 'workers-ai')!;
    expect(template).toMatchObject({ label: 'Cloudflare Workers AI', apiFormat: 'openai', keyRequired: true });
    const input = { ...entry, provider: template.id, apiUrl: template.defaultUrl };
    expect(() => manager.saveModel(input)).toThrow('Account ID');
    expect(() => manager.store.import({ models: [input] })).toThrow('Account ID');
    await expect(manager.discoverModels(input)).rejects.toThrow('Account ID');
    await expect(
      manager.discoverModels({ ...input, apiUrl: `https://api.cloudflare.com${workersPath}/v1`, apiKey: '' }),
    ).rejects.toThrow('API token');
  });

  it('authenticates Workers AI catalog pages and uses model names instead of native UUIDs', async () => {
    const requests: string[] = [];
    const url = await server((req, res) => {
      expect(req.headers.authorization).toBe('Bearer private-workers-token');
      const request = new URL(req.url!, 'http://localhost');
      expect(request.pathname).toBe(`${workersPath}/models/search`);
      expect(request.searchParams.get('format')).toBe('openrouter');
      expect(request.searchParams.get('task')).toBe('Text Generation');
      requests.push(req.url!);
      const page = Number(request.searchParams.get('page'));
      res.end(
        JSON.stringify({
          success: true,
          result:
            page === 1
              ? [
                  { id: 'model-uuid-1', name: '@cf/text-one', task: { name: 'Text Generation' } },
                  { id: 'image-uuid', name: '@cf/image-model', task: { name: 'Text-to-Image' } },
                ]
              : [{ id: 'model-uuid-2', name: '@cf/text-two', task: { name: 'Text Generation' } }],
          result_info: { page, per_page: 2, total_count: 3, total_pages: 2 },
        }),
      );
    });
    const { manager } = setup();
    const input = {
      provider: 'workers-ai',
      apiUrl: `${url}${workersPath}/v1/chat/completions`,
      apiKey: 'private-workers-token',
    };
    expect((await manager.discoverModels(input)).models.map((model) => model.id)).toEqual([
      '@cf/text-one',
      '@cf/text-two',
    ]);
    expect(requests).toHaveLength(2);
    const result = await manager.testModel({ ...input, externalModelName: '@cf/text-two' });
    expect(result).toMatchObject({
      success: true,
      message: 'Model listing verified (2 models). Generation was not tested.',
    });
    expect(JSON.stringify(result)).not.toContain('private-workers-token');
  });

  it('preserves Workers AI marketplace metadata and follows pages without result_info', async () => {
    const pages: number[] = [];
    const url = await server((req, res) => {
      const page = Number(new URL(req.url!, 'http://localhost').searchParams.get('page'));
      pages.push(page);
      res.end(
        JSON.stringify({
          data:
            page === 1
              ? Array.from({ length: 100 }, (_, i) => ({
                  id: `@cf/text-${i}`,
                  name: `Text ${i}`,
                  context_length: 32768,
                  top_provider: { max_completion_tokens: 4096 },
                  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
                }))
              : [
                  { id: '@cf/last', architecture: { output_modalities: ['text'] } },
                  { id: '@cf/image', architecture: { output_modalities: ['image'] } },
                ],
        }),
      );
    });
    const { manager } = setup();
    const found = await manager.discoverModels({
      provider: 'workers-ai',
      apiUrl: `${url}${workersPath}/v1`,
      apiKey: 'secret',
    });
    expect(pages).toEqual([1, 2]);
    expect(found.models).toHaveLength(101);
    expect(found.models[0]).toMatchObject({
      id: '@cf/text-0',
      displayName: 'Text 0',
      contextWindow: 32768,
      maxOutputTokens: 4096,
      supportsVision: true,
    });
  });

  it.each([
    { authorization: 'Bearer private-header-token' },
    { 'X-Auth-Key': 'private-global-key', 'x-AUTH-email': 'test@example.test' },
  ])('uses saved Workers AI authentication headers with no API-key field: %j', async (customHeaders) => {
    let requests = 0;
    const url = await server((req, res) => {
      requests++;
      expect(new URL(req.url!, 'http://localhost').pathname).toBe(`${workersPath}/models/search`);
      const expected = Object.fromEntries(
        Object.entries(customHeaders).map(([key, value]) => [key.toLowerCase(), value]),
      );
      const authenticated = Object.entries(expected).every(([key, value]) => req.headers[key] === value);
      if (!expected.authorization) expect(req.headers.authorization).toBeUndefined();
      res.writeHead(authenticated ? 200 : 401);
      res.end(JSON.stringify({ data: [{ id: '@cf/text-one' }] }));
    });
    const { manager } = setup();
    manager.saveModel({
      ...entry,
      provider: 'workers-ai',
      externalModelName: '@cf/text-one',
      apiUrl: `${url}${workersPath}/v1`,
      apiKey: 'none',
      customHeaders,
    });
    const masked = manager.store.list()[0];
    expect(Object.values(masked.customHeaders!)).toEqual(Object.keys(customHeaders).map(() => '********'));
    expect((await manager.discoverModels(masked)).models.map((model) => model.id)).toEqual(['@cf/text-one']);
    const result = await manager.testModel(masked);
    expect(result).toMatchObject({
      success: true,
      message: 'Model listing verified (1 models). Generation was not tested.',
    });
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(requests).toBe(2);
    const invalidHeaders = Object.fromEntries(Object.keys(customHeaders).map((key) => [key, 'invalid']));
    await expect(manager.testModel({ ...masked, customHeaders: invalidHeaders })).rejects.toThrow('HTTP 401');
    expect(requests).toBe(3);
  });

  it.each([401, 403, 404, 405])('never treats a Workers AI HTTP %i as a successful connection', async (status) => {
    const url = await server((_req, res) => {
      res.writeHead(status);
      res.end(JSON.stringify({ errors: [{ message: 'private-workers-token' }] }));
    });
    const { manager } = setup();
    const request = manager.testModel({
      provider: 'workers-ai',
      apiUrl: `${url}${workersPath}/v1`,
      apiKey: 'private-workers-token',
    });
    await expect(request).rejects.toThrow(`HTTP ${status}`);
    await expect(request).rejects.not.toThrow('private-workers-token');
    await expect(request).rejects.toThrow(
      status === 401 || status === 403 ? 'Workers AI' : 'generation was not tested',
    );
  });

  it.each(['failure', 'repeat', 'empty', 'wrong-page'])(
    'rejects a Workers AI %s catalog rather than reporting success',
    async (kind) => {
      const url = await server((req, res) => {
        const page = Number(new URL(req.url!, 'http://localhost').searchParams.get('page'));
        res.end(
          JSON.stringify({
            success: kind !== 'failure',
            result: kind === 'empty' ? [] : [{ name: '@cf/text-one' }],
            result_info: { page: kind === 'wrong-page' ? 3 : page, total_count: 5 },
          }),
        );
      });
      const { manager } = setup();
      await expect(
        manager.discoverModels({ provider: 'workers-ai', apiUrl: `${url}${workersPath}/v1`, apiKey: 'secret' }),
      ).rejects.toThrow(/failed|repeated|incomplete|unexpected/);
    },
  );

  it('never forwards Workers AI credentials across a catalog redirect', async () => {
    let redirected = false;
    const destination = await server((_req, res) => {
      redirected = true;
      res.end('{}');
    });
    const url = await server((_req, res) => {
      res.writeHead(302, { Location: destination });
      res.end();
    });
    const { manager } = setup();
    await expect(
      manager.discoverModels({
        provider: 'workers-ai',
        apiUrl: `${url}${workersPath}/v1`,
        apiKey: 'private-workers-token',
      }),
    ).rejects.toThrow('HTTP 302');
    expect(redirected).toBe(false);
  });

  it('discovers a large OpenRouter-style catalog with metadata and skips non-chat outputs', async () => {
    const catalog = Array.from({ length: 450 }, (_, index) => ({
      id: `vendor/model-${index}`,
      name: `Model ${index}`,
      context_length: 128000,
      top_provider: { max_completion_tokens: 8192 },
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      supported_parameters: ['tools', 'reasoning'],
    }));
    const url = await server((req, res) => {
      expect(req.url).toBe('/api/v1/models');
      expect(req.headers.authorization).toBe('Bearer catalog-key');
      res.end(
        JSON.stringify({
          data: [...catalog, catalog[0], { id: 'image-only', architecture: { output_modalities: ['image'] } }],
        }),
      );
    });
    const { manager } = setup();
    const found = await manager.discoverModels({
      provider: 'openrouter',
      apiUrl: `${url}/api/v1/chat/completions`,
      apiKey: 'catalog-key',
    });
    expect(found.models).toHaveLength(450);
    expect(found.models[449]).toEqual({
      id: 'vendor/model-449',
      displayName: 'Model 449',
      contextWindow: 128000,
      maxOutputTokens: 8192,
      supportsVision: true,
      supportsThinking: true,
    });
  });

  it('accepts Together-style top-level arrays and keeps chat models with context limits', async () => {
    const url = await server((_req, res) =>
      res.end(
        JSON.stringify([
          { id: 'org/chat-model', display_name: 'Chat model', type: 'chat', context_length: 64000 },
          { id: 'org/embedding-model', type: 'embedding' },
          { id: 'org/image-model', type: 'image' },
        ]),
      ),
    );
    const { manager } = setup();
    const found = await manager.discoverModels({
      provider: 'together',
      apiUrl: `${url}/v1/chat/completions`,
      apiKey: 'test',
    });
    expect(found.models).toEqual([{ id: 'org/chat-model', displayName: 'Chat model', contextWindow: 64000 }]);
  });

  it('uses the DashScope listing API on the configured origin and reads every advertised page', async () => {
    const paths: string[] = [];
    const url = await server((req, res) => {
      expect(req.headers.authorization).toBe('Bearer regional-key');
      const requested = new URL(req.url!, 'http://localhost');
      expect(requested.pathname).toBe('/api/v1/models');
      expect(requested.searchParams.get('capabilities')).toBe('TG');
      expect(requested.searchParams.get('page_size')).toBe('100');
      paths.push(requested.searchParams.get('page_no')!);
      const page = requested.searchParams.get('page_no');
      res.end(
        JSON.stringify({
          output: {
            total: 2,
            models: [
              {
                model: `qwen-${page}`,
                name: `Friendly Qwen ${page}`,
                model_info: { context_window: 32768 },
                inference_metadata: { request_modality: ['Text', 'Image'] },
              },
            ],
          },
        }),
      );
    });
    const { manager } = setup();
    const found = await manager.discoverModels({
      provider: 'dashscope',
      apiFormat: 'openai',
      apiUrl: `${url}/compatible-mode/v1/chat/completions`,
      apiKey: 'regional-key',
    });
    expect(paths).toEqual(['1', '2']);
    expect(found.models).toEqual(
      [1, 2].map((i) => ({
        id: `qwen-${i}`,
        displayName: `Friendly Qwen ${i}`,
        contextWindow: 32768,
        supportsVision: true,
      })),
    );
  });

  it('uses Fireworks resource names, Bearer listing auth, and continuation tokens', async () => {
    const pages: string[] = [];
    const url = await server((req, res) => {
      expect(req.headers.authorization).toBe('Bearer fireworks-key');
      const requested = new URL(req.url!, 'http://localhost');
      expect(requested.pathname).toBe('/v1/accounts/fireworks/models');
      expect(requested.searchParams.get('pageSize')).toBe('200');
      const cursor = requested.searchParams.get('pageToken') || '';
      pages.push(cursor);
      res.end(
        JSON.stringify({
          models: [
            {
              name: `accounts/fireworks/models/chat-${pages.length}`,
              displayName: 'Example chat',
              kind: 'HF_BASE_MODEL',
              state: 'READY',
              supportsServerless: true,
            },
            { name: 'embedding', kind: 'EMBEDDING_MODEL' },
            { name: 'private-only', supportsServerless: false },
          ],
          ...(cursor ? {} : { nextPageToken: 'cursor+/=' }),
        }),
      );
    });
    const { manager } = setup();
    const found = await manager.discoverModels({
      provider: 'fireworks',
      apiUrl: `${url}/inference/v1/chat/completions`,
      apiKey: 'fireworks-key',
    });
    expect(pages).toEqual(['', 'cursor+/=']);
    expect(found.models.map((value) => value.id)).toEqual([
      'accounts/fireworks/models/chat-1',
      'accounts/fireworks/models/chat-2',
    ]);
  });

  it('rejects repeated model page tokens instead of looping or returning a partial catalog', async () => {
    let calls = 0;
    const url = await server((_req, res) => {
      calls++;
      res.end(JSON.stringify({ models: [{ name: 'accounts/fireworks/models/one' }], nextPageToken: 'repeat' }));
    });
    const { manager } = setup();
    await expect(
      manager.discoverModels({ provider: 'fireworks', apiUrl: `${url}/inference/v1`, apiKey: 'test' }),
    ).rejects.toThrow('invalid model page token');
    expect(calls).toBe(2);
  });

  it('keeps HF context conservative and maps Novita/SambaNova catalog fields', async () => {
    const url = await server((_req, res) =>
      res.end(
        JSON.stringify({
          data: [
            { id: 'hf/model', providers: [{ context_length: 32768 }, { context_length: 65536 }] },
            { id: 'hf/unknown-route', providers: [{ context_length: 32768 }, {}] },
            { id: 'novita/model', title: 'Novita model', context_size: 8192 },
            { id: 'samba/model', context_length: 16384, max_completion_tokens: 4096 },
            { id: 'deepseek/model', context_window: 131072, max_output_tokens: 8192 },
            { id: 'hf/incomplete', providers: [null, { context_length: 32768 }] },
          ],
        }),
      ),
    );
    const { manager } = setup();
    const found = await manager.discoverModels({ provider: 'custom', apiUrl: `${url}/v1` });
    expect(found.models[0]).toMatchObject({ contextWindow: 32768 });
    expect(found.models[1]).not.toHaveProperty('contextWindow');
    expect(found.models[2]).toMatchObject({ displayName: 'Novita model', contextWindow: 8192 });
    expect(found.models[3]).toMatchObject({ contextWindow: 16384, maxOutputTokens: 4096 });
    expect(found.models[4]).toMatchObject({ contextWindow: 131072, maxOutputTokens: 8192 });
    expect(found.models[5]).not.toHaveProperty('contextWindow');
  });

  it('probes saved masked credentials and verifies the chosen model without generating', async () => {
    const requests: string[] = [];
    const url = await server((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      expect(req.headers.authorization).toBe('Bearer private-key');
      expect(req.headers['x-project']).toBe('private-header');
      res.end(JSON.stringify({ data: [{ id: 'test' }] }));
    });
    const { manager } = setup();
    manager.store.save({ ...entry, apiUrl: url });
    const result = await manager.testModel(manager.store.list()[0]);
    expect(result.success).toBe(true);
    expect(result.message).toContain('Generation was not tested');
    expect(requests).toEqual(['GET /v1/models']);
    expect((await manager.testModel({ ...manager.store.list()[0], externalModelName: 'missing' })).success).toBe(false);
  });

  it.each([301, 400, 401, 403, 404, 405, 422, 429, 500])(
    'rejects HTTP %i instead of claiming a working model',
    async (status) => {
      const url = await server((_req, res) => {
        res.writeHead(status);
        res.end('{}');
      });
      const { manager } = setup();
      await expect(manager.testModel({ provider: 'openai', apiUrl: url })).rejects.toThrow(`HTTP ${status}`);
    },
  );

  it('rejects HTML success pages and malformed/empty model lists', async () => {
    const url = await server((_req, res) => res.end('<html>login</html>'));
    const { manager } = setup();
    await expect(manager.discoverModels({ provider: 'custom', apiUrl: url })).rejects.toThrow('JSON model list');
  });

  it('bounds incoming bodies and never follows redirects with credentials', async () => {
    const url = await server((_req, res) => res.end('x'.repeat(2 * 1024 * 1024 + 1)));
    await expect(requestJson(url)).rejects.toThrow('exceeds');
    let redirected = false;
    const target = await server((_req, res) => {
      redirected = true;
      res.end('{}');
    });
    const redirect = await server((_req, res) => {
      res.writeHead(302, { Location: target });
      res.end();
    });
    expect((await requestJson(redirect, { Authorization: 'Bearer secret' })).status).toBe(302);
    expect(redirected).toBe(false);
  });

  it.each([
    ['https://x.test/v1/chat/completions', 'openai', 'https://x.test/v1/models'],
    ['https://x.test/anthropic/v1/messages', 'anthropic', 'https://x.test/anthropic/v1/models'],
    ['https://x.test/v1beta/models/a:generateContent', 'google', 'https://x.test/v1beta/models'],
    ['https://x.test/v3/openai/chat/completions', 'openai', 'https://x.test/v3/openai/models'],
    ['https://x.test/openai/v1/chat/completions', 'openai', 'https://x.test/openai/v1/models'],
    ['https://x.test/compatible-mode/v1/chat/completions', 'openai', 'https://x.test/compatible-mode/v1/models'],
  ])('normalizes model discovery path %s', (url, format, expected) => expect(modelListUrl(url, format)).toBe(expected));
});

describe('authenticated gateway integration', () => {
  it('imports gateway aliases, encrypts the token, and keeps secrets out of the renderer', async () => {
    const url = await server((req, res) => {
      expect(req.url).toBe('/models');
      expect(req.headers.authorization).toBe('Bearer gateway-secret');
      res.end(
        JSON.stringify({
          models: [
            {
              name: 'models/fast',
              displayName: 'Fast',
              contextWindow: 8192,
              supportsVision: false,
              supportsThinking: true,
            },
          ],
        }),
      );
    });
    const { directory, manager } = setup();
    await expect(manager.importGatewayModels({ url, token: 'gateway-secret', dashboardUrl: url })).resolves.toEqual({
      success: true,
      count: 1,
    });
    const model = manager.store.list()[0];
    expect(model).toMatchObject({
      provider: 'google',
      apiFormat: 'google',
      externalModelName: 'fast',
      apiUrl: `${url}/v1beta`,
      apiKey: '********',
    });
    expect(model).toMatchObject({ gateway: true, contextWindow: 8192, supportsVision: false, supportsThinking: true });
    expect(manager.getGateway().token).toBe('********');
    expect(fs.readFileSync(path.join(directory, 'gateway_connection.json'), 'utf8')).not.toContain('gateway-secret');
    expect((await manager.testGateway()).success).toBe(true);
    expect(() => manager.saveGateway({ url: 'https://different.test', token: '********' })).toThrow('new gateway');
  });

  it('fails closed when local credential decryption fails', async () => {
    const { directory } = setup();
    const manager = createModelManager(
      directory,
      { ...codec, decryptString: () => 'DECRYPTION_FAILED' },
      async () => {},
    );
    new ModelStore(manager.store.filename, codec).save(entry);
    await expect(manager.discoverModels(manager.store.list()[0])).rejects.toThrow('cannot be decrypted');
  });
});
