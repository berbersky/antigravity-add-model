/** Read-only context information. Native transcripts omit system prompts and usage metadata. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

export interface ContextModel {
  name?: string;
  displayName?: string;
  externalModelName?: string;
  provider?: string;
  contextWindow?: number;
}
export interface ChatContextRequest {
  conversationId?: string;
  title?: string;
  modelName?: string;
  discoverLimit?: boolean;
}
export interface ChatContextUsage {
  conversationId: string;
  source: 'estimated' | 'unavailable';
  /** Visible transcript only: excludes hidden prompts, tool definitions and images. */
  currentTokens?: number;
  maxTokens?: number;
  limitSource?: 'configured' | 'public-catalog';
}
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const transcriptCache = new Map<string, { stamp: string; result: ChatContextUsage }>();
const pendingTranscripts = new Map<string, Promise<ChatContextUsage>>();
const validLimit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const label = (value?: string) =>
  typeof value === 'string' ? value.trim().replace(/[▾▲▼◂▸◀▶]/g, '').replace(/\s+/g, ' ').trim().toLowerCase() : '';
const modelKey = (value?: string) => label(value).replace(/^models\//, '').replace(/[^a-z0-9]/g, '');

/** Never let an earlier prefix match shadow an exact model or effort variant. */
export function findContextModel(name: string | undefined, models: ContextModel[]): ContextModel | undefined {
  const nameLabel = label(name);
  if (!nameLabel) return undefined;
  for (const field of ['displayName', 'name', 'externalModelName'] as const) {
    const matches = models.filter((model) => label(model[field]) === nameLabel);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
  }
  const key = modelKey(name);
  const matches = models.filter((model) =>
    [model.displayName, model.name, model.externalModelName].some((value) => value && modelKey(value) === key));
  return matches.length === 1 ? matches[0] : undefined;
}

/** A title is usable only when it identifies one conversation, including archived rows. */
export function findConversationIdByTitle(title: unknown, dataDirectory: string): string | undefined {
  if (typeof title !== 'string' || !title.trim() || title.length > 512) return undefined;
  const filename = path.join(dataDirectory, 'conversation_summaries.db');
  if (!fs.existsSync(filename)) return undefined;
  try {
    // Electron versions without node:sqlite simply leave identity unavailable.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      const rows = db.prepare('SELECT conversation_id FROM conversation_summaries WHERE title = ? LIMIT 2')
        .all(title.trim()) as { conversation_id: string }[];
      return rows.length === 1 && UUID.test(rows[0].conversation_id) ? rows[0].conversation_id : undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export async function getChatContextUsage(
  conversationId: unknown,
  dataDirectory: string,
): Promise<ChatContextUsage> {
  const id = typeof conversationId === 'string' && UUID.test(conversationId) ? conversationId : '';
  const unavailable: ChatContextUsage = { conversationId: id, source: 'unavailable' };
  if (!id) return unavailable;
  const filename = path.join(dataDirectory, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
  try {
    const stat = await fs.promises.stat(filename);
    // Do not show a truncated tail as the whole context. Large/unsupported files are explicitly unavailable.
    if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) return unavailable;
    const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    const cached = transcriptCache.get(filename);
    if (cached?.stamp === stamp) return { ...cached.result };
    const pending = pendingTranscripts.get(filename);
    if (pending) return { ...await pending };
    const read = async (): Promise<ChatContextUsage> => {
      let characters = 0;
      let entries = 0;
      let malformed = false;
      const input = fs.createReadStream(filename, { encoding: 'utf8' });
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string' ||
                typeof entry.source !== 'string') {
              malformed = true;
              continue;
            }
            // The native structured CHECKPOINT starts a new visible context.
            // Quoted "resuming" text in user messages is never a checkpoint.
            if (entry.type === 'CHECKPOINT' && entry.source === 'SYSTEM') characters = 0;
            if (typeof entry.content === 'string') characters += entry.content.length;
            if (typeof entry.thinking === 'string') characters += entry.thinking.length;
            if (Array.isArray(entry.tool_calls)) characters += JSON.stringify(entry.tool_calls).length;
            entries++;
          } catch {
            malformed = true;
          }
        }
      } finally {
        lines.close();
        input.destroy();
      }
      const after = await fs.promises.stat(filename);
      // A concurrent append or partial JSON line must not cache a falsely small count.
      if (malformed || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || !entries) return unavailable;
      const result: ChatContextUsage = { conversationId: id, source: 'estimated', currentTokens: Math.ceil(characters / 4) };
      if (transcriptCache.size >= 100) transcriptCache.delete(transcriptCache.keys().next().value!);
      transcriptCache.set(filename, { stamp, result });
      return { ...result };
    };
    const promise = read();
    pendingTranscripts.set(filename, promise);
    try {
      return await promise;
    } finally {
      pendingTranscripts.delete(filename);
    }
  } catch {
    return unavailable;
  }
}

type Catalog = Record<string, { models?: Record<string, { name?: string; limit?: { context?: number } }> }>;
let catalog: Catalog | undefined;
let catalogExpires = 0;
let catalogPending: Promise<Catalog | undefined> | undefined;

async function publicCatalog(): Promise<Catalog | undefined> {
  if (Date.now() < catalogExpires) return catalog;
  if (catalogPending) return catalogPending;
  catalogPending = (async () => {
    catalogExpires = Date.now() + 60_000;
    try {
      // A fixed public catalog URL receives no conversation, model name or credentials.
      const response = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(5000) });
      if (!response.ok || !response.body) return undefined;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 32 * 1024 * 1024) return undefined;
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
      catalog = parsed;
      catalogExpires = Date.now() + 300_000;
      return catalog;
    } catch {
      return undefined;
    }
  })();
  try {
    return await catalogPending;
  } finally {
    catalogPending = undefined;
  }
}

/** Exact catalog identifiers only; conflicting provider limits remain unknown. */
export async function discoverContextLimit(modelName: string, provider?: string): Promise<number | undefined> {
  const key = modelKey(modelName);
  if (!key) return undefined;
  const data = await publicCatalog();
  if (!data) return undefined;
  const preferred = provider && data[provider]?.models ? [[provider, data[provider]]] as const : Object.entries(data);
  const limits = new Set<number>();
  for (const [, entry] of preferred) {
    if (!entry || typeof entry !== 'object' || !entry.models || typeof entry.models !== 'object') continue;
    for (const [id, model] of Object.entries(entry.models)) {
      if (!model || typeof model !== 'object' || !validLimit(model.limit?.context)) continue;
      if (modelKey(id) === key || modelKey(model.name) === key) limits.add(model.limit!.context!);
    }
  }
  return limits.size === 1 ? [...limits][0] : undefined;
}

export async function getContextInformation(
  payload: unknown,
  dataDirectory: string,
  models: ContextModel[],
): Promise<ChatContextUsage> {
  const request: ChatContextRequest = payload && typeof payload === 'object' ? payload : {};
  const id = request.conversationId || findConversationIdByTitle(request.title, dataDirectory);
  const result = await getChatContextUsage(id, dataDirectory);
  const name = typeof request.modelName === 'string' && request.modelName.length <= 512 ? request.modelName : '';
  const configured = findContextModel(name, models);
  if (validLimit(configured?.contextWindow)) {
    result.maxTokens = configured.contextWindow;
    result.limitSource = 'configured';
  } else if (request.discoverLimit === true && name) {
    const limit = await discoverContextLimit(configured?.externalModelName || name, configured?.provider);
    if (limit) {
      result.maxTokens = limit;
      result.limitSource = 'public-catalog';
    }
  }
  return result;
}
