import { createHash } from 'node:crypto';
import type { GeminiBody } from './requestOptions';

export interface ReasoningReplayModel {
  name: string;
  provider: string;
  apiUrl: string;
  externalModelName?: string;
  apiFormat?: string;
  apiKey?: string;
  customHeaders?: Record<string, string>;
  rawUrl?: boolean;
}

type JsonObject = Record<string, unknown>;
interface Entry {
  reasoning: string | null;
  recordedAt: number;
}

const TTL = 30 * 60_000;
const MAX_ENTRIES = 256;
const MAX_ENTRY_CHARACTERS = 256 * 1024;
const MAX_TOTAL_CHARACTERS = 4 * 1024 * 1024;
const object = (value: unknown): JsonObject | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
const identifier = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value ? value : undefined;

/** Canonical JSON fingerprints do not depend on object-property insertion order. */
function canonical(value: unknown): string {
  let characters = 0;
  let nodes = 0;
  const add = (text: string) => {
    characters += text.length;
    if (characters > MAX_ENTRY_CHARACTERS) throw new Error('Fingerprint exceeds bound');
    return text;
  };
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > 10_000 || depth > 64) throw new Error('Fingerprint exceeds bound');
    if (item === null || typeof item === 'boolean' || typeof item === 'number') return add(JSON.stringify(item));
    if (typeof item === 'string') return add(JSON.stringify(item));
    if (Array.isArray(item))
      return add('[') + item.map((entry) => visit(entry ?? null, depth + 1)).join(add(',')) + add(']');
    const record = object(item);
    if (!record) throw new Error('Unsupported fingerprint value');
    const fields = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return (
      add('{') +
      fields.map((key) => add(JSON.stringify(key)) + add(':') + visit(record[key], depth + 1)).join(add(',')) +
      add('}')
    );
  };
  return visit(value, 0);
}

function scope(body: GeminiBody, model: ReasoningReplayModel): string | undefined {
  const conversation = [
    ['cascade_id', identifier(object(body.labels)?.cascade_id)],
    ['conversationId', identifier(body.conversationId)],
    ['sessionId', identifier(body.sessionId)],
  ].find((entry) => entry[1] !== undefined);
  if (!conversation || !model.name || !model.provider || !model.apiUrl) return undefined;
  try {
    // Credentials influence isolation, but neither their values nor the scope tuple are retained.
    return createHash('sha256')
      .update(
        canonical([
          conversation,
          model.name,
          model.provider,
          model.apiUrl,
          model.externalModelName || '',
          model.apiFormat || '',
          model.apiKey || '',
          model.customHeaders || {},
          model.rawUrl === true,
        ]),
      )
      .digest('hex');
  } catch {
    return undefined;
  }
}

function callGroup(parts: readonly unknown[]): string | undefined {
  const calls: { id: string; name: string; args: unknown }[] = [];
  const ids = new Set<string>();
  for (const value of parts) {
    const part = object(value);
    if (!part || part.functionCall === undefined) continue;
    const call = object(part.functionCall);
    const id = identifier(call?.id),
      name = identifier(call?.name);
    if (!id || !name || ids.has(id) || calls.length >= 256) return undefined;
    ids.add(id);
    calls.push({ id, name, args: call?.args ?? {} });
  }
  if (!calls.length) return undefined;
  try {
    calls.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    return createHash('sha256').update(canonical(calls)).digest('hex');
  } catch {
    return undefined;
  }
}

/** Volatile, bounded recovery for clients that omit thought parts from tool history. */
export class ReasoningReplayCache {
  private readonly entries = new Map<string, Entry>();
  private characters = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private remove(key: string): void {
    this.characters -= this.entries.get(key)?.reasoning?.length || 0;
    this.entries.delete(key);
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now < entry.recordedAt || now - entry.recordedAt >= TTL) this.remove(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.characters = 0;
  }

  /** Call only after successful completion, with all mapped thought/tool-call parts. */
  record(body: GeminiBody, model: ReasoningReplayModel, parts: readonly unknown[]): void {
    this.prune();
    const modelScope = scope(body, model);
    if (!modelScope) return;
    const group = callGroup(parts);
    if (!group) return;
    const reusedHistoryGroup = body.contents?.some(
      (content) => content.role === 'model' && Array.isArray(content.parts) && callGroup(content.parts) === group,
    );
    let reasoning = '';
    for (const value of reusedHistoryGroup ? [] : parts) {
      const part = object(value);
      if (!part?.thought || typeof part.text !== 'string') continue;
      if (reasoning.length + part.text.length > MAX_ENTRY_CHARACTERS) return;
      reasoning += part.text;
    }
    const key = `${modelScope}:${group}`;
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.reasoning !== reasoning && existing.reasoning !== null) {
        // Reused IDs with different reasoning are ambiguous until expiration; never guess.
        this.characters -= existing.reasoning.length;
        existing.reasoning = null;
      }
      return;
    }
    // Empty turns and groups already present in history block later reuse, even
    // when the earlier observation has expired or was evicted from this cache.
    this.entries.set(key, { reasoning: reasoning || null, recordedAt: this.now() });
    this.characters += reasoning.length;
    while (this.entries.size > MAX_ENTRIES || this.characters > MAX_TOTAL_CHARACTERS) {
      this.remove(this.entries.keys().next().value!);
    }
  }

  /** Recover before context budgeting; return a copy only when a history item changes. */
  restore<T extends GeminiBody>(body: T, model: ReasoningReplayModel): T {
    this.prune();
    const modelScope = scope(body, model);
    if (!modelScope || !Array.isArray(body.contents)) return body;
    let changed = false;
    const contents = body.contents.map((content) => {
      if (content.role !== 'model' || !Array.isArray(content.parts) || content.parts.some((part) => part.thought))
        return content;
      const group = callGroup(content.parts);
      if (!group) return content;
      const reasoning = this.entries.get(`${modelScope}:${group}`)?.reasoning;
      if (!reasoning) return content;
      changed = true;
      return { ...content, parts: [{ text: reasoning, thought: true }, ...content.parts] };
    });
    return changed ? { ...body, contents } : body;
  }
}

export const reasoningReplayCache = new ReasoningReplayCache();
