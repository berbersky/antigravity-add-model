import { describe, expect, it } from 'vitest';
import { ReasoningReplayCache, type ReasoningReplayModel } from '../proxy/reasoningReplay';
import type { GeminiBody } from '../proxy/requestOptions';

const model: ReasoningReplayModel = {
  name: 'models/reasoning',
  provider: 'openai',
  apiUrl: 'https://provider.test/v1',
  externalModelName: 'reasoner',
  apiKey: 'fixture-key',
};
const body = (identity: Record<string, unknown> = { labels: { cascade_id: 'conversation-a' } }): GeminiBody => ({
  ...identity,
  contents: [{ role: 'user', parts: [{ text: 'Read the fixture.' }] }],
});
const call = (id = 'call-a', name = 'view_file', args: unknown = { path: '/fixture.txt', start: 1 }) => ({
  functionCall: { id, name, args },
});
const thought = (text = 'Keep the verified plan.') => ({ thought: true, text });
const history = (parts = [call()], identity?: Record<string, unknown>): GeminiBody => ({
  ...body(identity),
  contents: [...body().contents, { role: 'model', parts }],
});
const recovered = (value: GeminiBody) =>
  value.contents?.[1].parts
    ?.filter((part) => part.thought)
    .map((part) => part.text)
    .join('');

describe('reasoning replay across native tool turns', () => {
  it('restores completed thought chunks without mutating input or exposing them as visible text', () => {
    const cache = new ReasoningReplayCache();
    cache.record(body(), model, [thought('Keep '), thought('the verified plan.'), call()]);
    const original = history();
    const snapshot = structuredClone(original);
    const result = cache.restore(original, model);
    expect(recovered(result)).toBe('Keep the verified plan.');
    expect(original).toEqual(snapshot);
    expect(result).not.toBe(original);
    expect(result.contents?.[0]).toBe(original.contents?.[0]);
    expect(result.contents?.[1].parts?.filter((part) => !part.thought)).toEqual([call()]);
  });

  it('matches canonical arguments and a whole parallel group even if its order changes', () => {
    const cache = new ReasoningReplayCache();
    cache.record(body(), model, [thought(), call(), call('call-b', 'list_dir', { path: '/fixtures' })]);
    expect(recovered(cache.restore(history([call()]), model))).toBe('');
    const parallel = history([
      call('call-b', 'list_dir', { path: '/fixtures' }),
      call('call-a', 'view_file', { start: 1, path: '/fixture.txt' }),
    ]);
    expect(recovered(cache.restore(parallel, model))).toBe('Keep the verified plan.');
    expect(recovered(cache.restore(history([call(), call('call-b', 'list_dir', { path: '/different' })]), model))).toBe(
      '',
    );
    expect(recovered(cache.restore(history([call(), call('call-c')]), model))).toBe('');
  });

  it.each([
    { name: 'models/other' },
    { provider: 'openrouter' },
    { apiUrl: 'https://other.test/v1' },
    { externalModelName: 'another-model' },
    { apiKey: 'other-credential' },
    { customHeaders: { Authorization: 'another-credential' } },
    { apiFormat: 'anthropic' },
    { rawUrl: true },
  ])('isolates configured provider/model/credential changes: %j', (change) => {
    const cache = new ReasoningReplayCache();
    cache.record(body(), model, [thought(), call()]);
    expect(cache.restore(history(), { ...model, ...change })).toEqual(history());
  });

  it.each(['conversationId', 'sessionId'])('accepts a stable %s when cascade identity is absent', (field) => {
    const cache = new ReasoningReplayCache();
    cache.record(body({ [field]: 'conversation-a' }), model, [thought(), call()]);
    expect(recovered(cache.restore(history([call()], { [field]: 'conversation-a' }), model))).toBe(
      'Keep the verified plan.',
    );
    expect(recovered(cache.restore(history([call()], { [field]: 'other' }), model))).toBe('');
  });

  it('prefers cascade_id, then conversationId, and never caches unidentified requests', () => {
    const cache = new ReasoningReplayCache();
    cache.record(
      body({ labels: { cascade_id: 'cascade' }, conversationId: 'conversation', sessionId: 'session' }),
      model,
      [thought(), call()],
    );
    expect(
      recovered(
        cache.restore(history([call()], { labels: { cascade_id: 'cascade' }, conversationId: 'changed' }), model),
      ),
    ).toBe('Keep the verified plan.');
    expect(recovered(cache.restore(history([call()], { conversationId: 'conversation' }), model))).toBe('');
    cache.record(body({ conversationId: 'conversation', sessionId: 'session' }), model, [thought(), call('second')]);
    expect(
      recovered(
        cache.restore(history([call('second')], { conversationId: 'conversation', sessionId: 'changed' }), model),
      ),
    ).toBe('Keep the verified plan.');
    cache.record(body({}), model, [thought(), call('anonymous')]);
    const anonymous = history([call('anonymous')], {});
    expect(cache.restore(anonymous, model)).toBe(anonymous);
    expect(recovered(cache.restore(history([call()], { labels: { cascade_id: 'another' } }), model))).toBe('');
  });

  it('requires exact IDs and names, rejects missing/duplicate IDs, and leaves non-model turns untouched', () => {
    const cache = new ReasoningReplayCache();
    cache.record(body(), model, [thought(), call()]);
    for (const parts of [[call('different')], [call('call-a', 'other')], [call('')], [call(), call()]]) {
      const value = history(parts);
      expect(cache.restore(value, model)).toBe(value);
    }
    const value = history();
    value.contents![1].role = 'user';
    expect(cache.restore(value, model)).toBe(value);
    const invalidCache = new ReasoningReplayCache();
    invalidCache.record(body(), model, [thought(), call(), call('')]);
    invalidCache.record(body(), model, [thought(), call(), call()]);
    expect(recovered(invalidCache.restore(history(), model))).toBe('');
  });

  it.each(['Explicit native thought.', ''])(
    'never changes an existing thought part, including an empty one',
    (text) => {
      const cache = new ReasoningReplayCache();
      cache.record(body(), model, [thought(), call()]);
      const value = history();
      value.contents![1].parts!.unshift(thought(text));
      expect(cache.restore(value, model)).toBe(value);
      expect(recovered(value)).toBe(text);
    },
  );

  it('keeps separate sequential turns and refuses conflicting reuse of the same call group', () => {
    const cache = new ReasoningReplayCache();
    cache.record(body(), model, [thought('First plan'), call()]);
    cache.record(body(), model, [thought('Second plan'), call('second')]);
    expect(recovered(cache.restore(history(), model))).toBe('First plan');
    expect(recovered(cache.restore(history([call('second')]), model))).toBe('Second plan');
    cache.record(body(), model, [thought('Conflicting plan'), call()]);
    cache.record(body(), model, [thought('First plan'), call()]);
    expect(recovered(cache.restore(history(), model))).toBe('');
    expect(recovered(cache.restore(history([call('second')]), model))).toBe('Second plan');
  });

  it.each([true, false])(
    'blocks a reused group when one completed turn has no reasoning (empty first=%s)',
    (emptyFirst) => {
      const cache = new ReasoningReplayCache();
      const empty = [call()];
      const populated = [thought(), call()];
      cache.record(body(), model, emptyFirst ? empty : populated);
      cache.record(body(), model, emptyFirst ? populated : empty);
      expect(recovered(cache.restore(history(), model))).toBe('');
      cache.record(body(), model, populated);
      expect(recovered(cache.restore(history(), model))).toBe('');
    },
  );

  it('does not share equal identifier values across different identity kinds', () => {
    const identities = [{ labels: { cascade_id: 'same-id' } }, { conversationId: 'same-id' }, { sessionId: 'same-id' }];
    for (const source of identities) {
      const cache = new ReasoningReplayCache();
      cache.record(body(source), model, [thought(), call()]);
      for (const target of identities) {
        expect(recovered(cache.restore(history([call()], target), model))).toBe(
          source === target ? 'Keep the verified plan.' : '',
        );
      }
    }
  });

  it('blocks reused call groups still in history after their earlier cache entry expires', () => {
    let now = 0;
    const cache = new ReasoningReplayCache(() => now);
    cache.record(body(), model, [thought('Original turn'), call()]);
    now = 30 * 60_000;
    cache.record(history(), model, [thought('New turn with reused IDs'), call()]);
    expect(recovered(cache.restore(history(), model))).toBe('');
    cache.clear();
    cache.record(history(), model, [thought('No earlier cache entry'), call()]);
    expect(recovered(cache.restore(history(), model))).toBe('');
    cache.record(history(), model, [thought('Different call'), call('fresh')]);
    expect(recovered(cache.restore(history([call('fresh')]), model))).toBe('Different call');
  });

  it('expires after 30 minutes without extending life on reads and clears on shutdown', () => {
    let now = 1_000;
    const cache = new ReasoningReplayCache(() => now);
    cache.record(body(), model, [thought(), call()]);
    now += 30 * 60_000 - 1;
    expect(recovered(cache.restore(history(), model))).toBe('Keep the verified plan.');
    now += 1;
    expect(recovered(cache.restore(history(), model))).toBe('');
    cache.record(body(), model, [thought(), call()]);
    cache.clear();
    expect(recovered(cache.restore(history(), model))).toBe('');
    cache.record(body(), model, [thought(), call()]);
    now -= 1;
    expect(recovered(cache.restore(history(), model))).toBe('');
  });

  it('bounds entry count and individual/total reasoning characters', () => {
    const cache = new ReasoningReplayCache();
    cache.record(body(), model, [thought('x'.repeat(256 * 1024 + 1)), call()]);
    expect(recovered(cache.restore(history(), model))).toBe('');
    for (let i = 0; i <= 256; i++) cache.record(body(), model, [thought(), call(`entry-${i}`)]);
    expect(recovered(cache.restore(history([call('entry-0')]), model))).toBe('');
    expect(recovered(cache.restore(history([call('entry-256')]), model))).toBe('Keep the verified plan.');
    cache.clear();
    for (let i = 0; i < 17; i++) cache.record(body(), model, [thought('x'.repeat(256 * 1024)), call(`large-${i}`)]);
    expect(recovered(cache.restore(history([call('large-0')]), model))).toBe('');
    expect(recovered(cache.restore(history([call('large-16')]), model))).toHaveLength(256 * 1024);
  });

  it('does not cache ordinary text or malformed/cyclic tool arguments', () => {
    const cache = new ReasoningReplayCache();
    cache.record(body(), model, [{ text: 'Visible answer' }, call()]);
    expect(recovered(cache.restore(history(), model))).toBe('');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => cache.record(body(), model, [thought(), call('cyclic', 'view_file', cyclic)])).not.toThrow();
    expect(() => cache.restore(history([call('cyclic', 'view_file', cyclic)]), model)).not.toThrow();
  });
});
