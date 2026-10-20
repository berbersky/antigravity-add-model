/**
 * Shared state module for proxy orchestration.
 * Extracted from proxy.js to decouple translators from main orchestration.
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface StreamContext {
  accumulatedText: string;
  accumulatedReasoning: string;
  toolCalls: Record<number, { id: string; name: string; arguments: string }>;
}

export interface StateTimestamps {
  streamCtx: Map<string, number>;
  toolCallIds: Map<string, number>;
  translatedCalls: Map<string, number>;
  reasoning: Map<string, number>;
}

export interface TranslatedCallInfo {
  originalName: string;
  translatedName: string;
  cmd: string;
  cwd: string;
}

// ─── State ────────────────────────────────────────────────────────────────

/** modelName → { "functionName": "original_tool_call_id" } */
export const modelToolCallIds = new Map<string, Record<string, string>>();

/** modelName → preserved reasoning_content from previous turn */
export const modelReasoningContent = new Map<string, string>();

/** streamId → { accumulatedText, accumulatedReasoning, toolCalls } */
export const activeStreamContexts = new Map<string, StreamContext>();

/** toolCallId → { originalName, translatedName, cmd, cwd } */
export const translatedToolCalls = new Map<string, TranslatedCallInfo>();

/** State entry timestamps for periodic cleanup */
export const stateTimestamps: StateTimestamps = {
  streamCtx: new Map(),
  toolCallIds: new Map(),
  translatedCalls: new Map(),
  reasoning: new Map(),
};

// ─── Helpers ──────────────────────────────────────────────────────────────

export function touchStateTimestamp(map: Map<string, number>, key: string): void {
  map.set(key, Date.now());
}

// ─── Periodic Cleanup (managed lifecycle) ─────────────────────────────────

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startCleanupInterval(): void {
  if (cleanupInterval) return; // already running
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    const STREAM_TTL = 600_000; // 10 minutes for active stream contexts
    const TOOL_TTL = 1_800_000; // 30 minutes for tool call IDs & reasoning

    for (const [key, ts] of stateTimestamps.streamCtx) {
      if (now - ts > STREAM_TTL) {
        activeStreamContexts.delete(key);
        stateTimestamps.streamCtx.delete(key);
      }
    }
    for (const [key, ts] of stateTimestamps.toolCallIds) {
      if (now - ts > TOOL_TTL) {
        modelToolCallIds.delete(key);
        stateTimestamps.toolCallIds.delete(key);
      }
    }
    for (const [key, ts] of stateTimestamps.translatedCalls) {
      if (now - ts > TOOL_TTL) {
        translatedToolCalls.delete(key);
        stateTimestamps.translatedCalls.delete(key);
      }
    }
    for (const [key, ts] of stateTimestamps.reasoning) {
      if (now - ts > TOOL_TTL) {
        modelReasoningContent.delete(key);
        stateTimestamps.reasoning.delete(key);
      }
    }
  }, 300_000);
  // Importing translator/model-management helpers must not keep a CLI process alive.
  cleanupInterval.unref?.();
}

export function stopCleanupInterval(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

// Auto-start for backward compatibility (will be replaced by proxy.ts lifecycle)
startCleanupInterval();

/** Native quota observations are volatile and isolated to the authenticated request scope. */
export interface OfficialQuotaScope {
  accountId: string;
  clientId?: string;
  project?: string;
  endpoint: string;
}
interface OfficialQuotaObservation {
  scope: OfficialQuotaScope;
  checkedAt: number;
  data: Record<string, unknown>;
}
const officialQuotas = new Map<string, OfficialQuotaObservation>();
const OFFICIAL_QUOTA_TTL = 10 * 60_000;
const OFFICIAL_QUOTA_CAPACITY = 128;

export function officialQuotaScopeKey(scope: OfficialQuotaScope): string {
  const endpoint = new URL(scope.endpoint);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (
    !scope.accountId ||
    [scope.accountId, scope.clientId, scope.project].some(
      (value) => value !== undefined && (typeof value !== 'string' || value.length > 4096),
    ) ||
    endpoint.username ||
    endpoint.password ||
    (!local &&
      (endpoint.protocol !== 'https:' ||
        !['cloudcode-pa.googleapis.com', 'daily-cloudcode-pa.googleapis.com'].includes(endpoint.hostname))) ||
    !['http:', 'https:'].includes(endpoint.protocol)
  )
    throw new Error('Invalid quota scope');
  return JSON.stringify([scope.accountId, scope.clientId || '', scope.project || '', endpoint.origin]);
}

export function recordOfficialQuota(
  data: Record<string, unknown>,
  scope: OfficialQuotaScope,
  checkedAt = Date.now(),
): void {
  const now = Date.now();
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    !Number.isFinite(checkedAt) ||
    checkedAt > now ||
    now - checkedAt >= OFFICIAL_QUOTA_TTL
  )
    return;
  const key = officialQuotaScopeKey(scope);
  // Keep only fields consumed by the quota parser; never retain an echoed request or credentials.
  const clean: Record<string, unknown> = {};
  let remainingBuckets = 256;
  const bucket = (value: unknown): Record<string, unknown> | undefined => {
    if (!value || typeof value !== 'object' || remainingBuckets-- <= 0) return undefined;
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const field of ['bucketId', 'id', 'modelId', 'displayName', 'title', 'label', 'resetTime']) {
      if (typeof source[field] === 'string') result[field] = source[field].slice(0, 512);
    }
    if (typeof source.remainingFraction === 'number' && Number.isFinite(source.remainingFraction))
      result.remainingFraction = Math.max(0, Math.min(1, source.remainingFraction));
    return result;
  };
  if (Array.isArray(data.buckets)) clean.buckets = data.buckets.slice(0, 256).map(bucket).filter(Boolean);
  if (Array.isArray(data.groups))
    clean.groups = data.groups.slice(0, 64).flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const source = value as Record<string, unknown>;
      const group: Record<string, unknown> = {};
      for (const field of ['name', 'displayName', 'title', 'label', 'id'])
        if (typeof source[field] === 'string') group[field] = source[field].slice(0, 512);
      group.buckets = Array.isArray(source.buckets) ? source.buckets.slice(0, 256).map(bucket).filter(Boolean) : [];
      return [group];
    });
  for (const field of ['subscriptionTier', 'userTier', 'planTier'])
    if (typeof data[field] === 'string') clean[field] = data[field].slice(0, 128);
  if (
    data.paidTier &&
    typeof data.paidTier === 'object' &&
    typeof (data.paidTier as Record<string, unknown>).tier === 'string'
  )
    clean.paidTier = { tier: ((data.paidTier as Record<string, unknown>).tier as string).slice(0, 128) };
  if (Buffer.byteLength(JSON.stringify(clean), 'utf8') > 128 * 1024) return;
  for (const [storedKey, entry] of officialQuotas)
    if (now < entry.checkedAt || now - entry.checkedAt >= OFFICIAL_QUOTA_TTL) officialQuotas.delete(storedKey);
  if ((officialQuotas.get(key)?.checkedAt ?? -1) > checkedAt) return;
  officialQuotas.delete(key);
  officialQuotas.set(key, { scope: { ...scope }, checkedAt, data: clean });
  while (officialQuotas.size > OFFICIAL_QUOTA_CAPACITY) officialQuotas.delete(officialQuotas.keys().next().value!);
}

export function getOfficialQuota(scope: OfficialQuotaScope): OfficialQuotaObservation | undefined {
  const key = officialQuotaScopeKey(scope);
  const entry = officialQuotas.get(key);
  if (!entry) return undefined;
  if (Date.now() < entry.checkedAt || Date.now() - entry.checkedAt >= OFFICIAL_QUOTA_TTL) {
    officialQuotas.delete(key);
    return undefined;
  }
  return JSON.parse(JSON.stringify(entry)) as OfficialQuotaObservation;
}

export function clearOfficialQuota(accountId?: string): void {
  for (const [key, entry] of officialQuotas)
    if (!accountId || entry.scope.accountId === accountId) officialQuotas.delete(key);
}
