import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const directories: string[] = [];
const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function directory() {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-context-'));
  directories.push(result);
  return result;
}
function transcript(root: string, entries: unknown[]) {
  const filename = path.join(root, 'brain', id, '.system_generated/logs/transcript.jsonl');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  return filename;
}
const message = (content: string) => ({ type: 'PLANNER_RESPONSE', source: 'MODEL', content });
beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of directories.splice(0)) {
    expect(path.dirname(root)).toBe(os.tmpdir());
    expect(path.basename(root)).toMatch(/^agy-context-/);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('context transcript estimates', () => {
  it('reads the native transcript format and labels it as a partial estimate', async () => {
    const root = directory();
    transcript(root, [
      { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'a'.repeat(40) },
      message('b'.repeat(80)),
    ]);
    const { getChatContextUsage } = await import('../chatContext');
    expect(await getChatContextUsage(id, root)).toEqual({ conversationId: id, source: 'estimated', currentTokens: 30 });
  });

  it('keeps all post-checkpoint text across the old 2 MiB boundary', async () => {
    const root = directory();
    const entries = Array.from({ length: 1000 }, () => message('x'.repeat(2000)));
    const filename = transcript(root, entries);
    const { getChatContextUsage } = await import('../chatContext');
    const before = await getChatContextUsage(id, root);
    fs.appendFileSync(filename, Array.from({ length: 100 }, () => JSON.stringify(message('y'.repeat(2000))) + '\n').join(''));
    const after = await getChatContextUsage(id, root);
    expect(before.currentTokens).toBe(500000);
    expect(after.currentTokens).toBe(550000);
  });

  it('resets only on a structured native system checkpoint', async () => {
    const root = directory();
    transcript(root, [
      message('x'.repeat(200)),
      { source: 'SYSTEM', type: 'CHECKPOINT', content: 's'.repeat(40) },
      { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Resuming from a compaction' },
      message('y'.repeat(40)),
    ]);
    const { getChatContextUsage } = await import('../chatContext');
    expect((await getChatContextUsage(id, root)).currentTokens).toBe(Math.ceil((80 + 'Resuming from a compaction'.length) / 4));
  });

  it('does not substitute a different chat, truncated JSON, or a huge file', async () => {
    const root = directory();
    const filename = transcript(root, [message('existing')]);
    const { getChatContextUsage } = await import('../chatContext');
    expect(await getChatContextUsage(undefined, root)).toEqual({ conversationId: '', source: 'unavailable' });
    expect(await getChatContextUsage('../outside', root)).toEqual({ conversationId: '', source: 'unavailable' });
    fs.appendFileSync(filename, '{"source":');
    expect((await getChatContextUsage(id, root)).source).toBe('unavailable');
    fs.truncateSync(filename, 64 * 1024 * 1024 + 1);
    expect((await getChatContextUsage(id, root)).source).toBe('unavailable');
  });

  it('does not guess between conversations with the same title', async () => {
    const root = directory();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(root, 'conversation_summaries.db'));
    db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT)');
    db.prepare('INSERT INTO conversation_summaries VALUES (?, ?)').run(id, 'Same title');
    const { findConversationIdByTitle } = await import('../chatContext');
    expect(findConversationIdByTitle('Same title', root)).toBe(id);
    db.prepare('INSERT INTO conversation_summaries VALUES (?, ?)').run('bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', 'Same title');
    expect(findConversationIdByTitle('Same title', root)).toBeUndefined();
    db.close();
  });
});

describe('context limits and profile isolation', () => {
  it('selects exact variants independently of ordering and rejects ambiguous aliases', async () => {
    const { findContextModel } = await import('../chatContext');
    const models = [
      { name: 'models/gpt-5', displayName: 'GPT-5', contextWindow: 400000 },
      { name: 'models/gpt-5-mini', displayName: 'GPT-5 Mini', contextWindow: 128000 },
    ];
    expect(findContextModel('GPT-5 Mini', models)?.contextWindow).toBe(128000);
    expect(findContextModel('GPT-5 Mini', [...models].reverse())?.contextWindow).toBe(128000);
    expect(findContextModel('GPT-5 Mini extended', models)).toBeUndefined();
    expect(findContextModel('Duplicate', models.map((model) => ({ ...model, displayName: 'Duplicate' })))).toBeUndefined();
  });

  it('discovers an exact public limit only after opt-in and never mutates either profile', async () => {
    const root = directory();
    const other = directory();
    const model = { name: 'models/alias', displayName: 'My model', externalModelName: 'exact-id', provider: 'acme' };
    for (const location of [root, other]) fs.writeFileSync(path.join(location, 'custom_models.json'), JSON.stringify({ models: [model] }));
    const before = [root, other].map((location) => fs.readFileSync(path.join(location, 'custom_models.json'), 'utf8'));
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      acme: { models: { 'exact-id-mini': { limit: { context: 32000 } }, 'exact-id': { limit: { context: 96000 } } } },
    })));
    vi.stubGlobal('fetch', fetch);
    const { getContextInformation } = await import('../chatContext');
    expect((await getContextInformation({ modelName: 'My model' }, root, [model])).maxTokens).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(await getContextInformation({ modelName: 'My model', discoverLimit: true }, root, [model]))
      .toMatchObject({ maxTokens: 96000, limitSource: 'public-catalog' });
    await getContextInformation({ modelName: 'My model', discoverLimit: true }, root, [model]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://models.dev/api.json');
    expect([root, other].map((location) => fs.readFileSync(path.join(location, 'custom_models.json'), 'utf8'))).toEqual(before);
  });

  it('uses the manager profile and explicit context without public network access', async () => {
    const root = directory();
    transcript(root, [message('x'.repeat(40))]);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { createModelActions } = await import('../modelActions');
    const actions = createModelActions({
      store: { filename: path.join(root, 'custom_models.json'), list: () => [{ name: 'models/exact', contextWindow: 42000 }] },
    } as any);
    expect(await actions['storage:get-chat-context-usage']({ conversationId: id, modelName: 'models/exact', discoverLimit: true }))
      .toMatchObject({ currentTokens: 10, maxTokens: 42000, limitSource: 'configured' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves conflicting public catalog aliases unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      one: { models: { 'model-id': { limit: { context: 32000 } } } },
      two: { models: { 'model-id': { limit: { context: 64000 } } } },
    }))));
    const { discoverContextLimit } = await import('../chatContext');
    expect(await discoverContextLimit('model-id')).toBeUndefined();
    expect(await discoverContextLimit('model-id', 'two')).toBe(64000);
  });

  it('clears an explicit preferred account while keeping repeated selection idempotent', async () => {
    const { createModelManager } = await import('../modelManagement');
    const root = directory();
    const manager = createModelManager(root, { encryptString: (value) => value, decryptString: (value) => value }, async () => {});
    manager.saveModel({ name: 'models/cloud', provider: 'google-cloudcode', apiUrl: 'https://cloudcode-pa.googleapis.com',
      externalModelName: 'gemini', apiKey: '', googleAccounts: [{ id: 'one', accessToken: 'test' }],
      googlePool: { strategy: 'round-robin', maxConcurrency: 2 } });
    manager.googleSelectAccount({ modelName: 'models/cloud', accountId: 'one' });
    manager.googleSelectAccount({ modelName: 'models/cloud', accountId: 'one' });
    expect(manager.store.read()[0].googlePool).toMatchObject({ preferredAccountId: 'one' });
    manager.googleSelectAccount({ modelName: 'models/cloud' });
    expect(manager.store.read()[0].googlePool).toEqual({ strategy: 'round-robin', maxConcurrency: 2 });
  });
});
