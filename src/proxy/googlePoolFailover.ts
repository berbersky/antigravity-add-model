import * as http from 'node:http';
import * as https from 'node:https';
import type { CustomModel } from '../proxy';
import {
  acquireGoogleAccount,
  googleAccountEndpoint,
  recordGoogleAccountFailure,
  type GoogleAccountLease,
} from '../googleAccounts';
import { classifyGoogleRateLimit } from '../googlePoolPolicy';
import { forwardNativeGeneration, type NativeSubagentRouting } from './nativeSubagentResponse';

const ERROR_LIMIT = 64 * 1024;
type PoolModel = Pick<CustomModel, 'name' | 'provider' | 'externalModelName' | 'googleAccounts' | 'googlePool'> &
  Partial<Pick<CustomModel, 'enabled' | 'apiUrl' | 'timeout' | 'retryBudgetMs'>>;

export interface PoolFailoverOptions {
  loadCustomModels: () => PoolModel[];
  forwardingHeaders: (source: http.IncomingHttpHeaders) => http.OutgoingHttpHeaders;
  trackUpstream?: (request: http.ClientRequest) => void;
  isStopping?: () => boolean;
  /** Dependency injection for local transport tests. */
  requestFn?: typeof http.request;
  timeoutMs?: number;
  log?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}

function parsedRequest(body: Buffer): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(body.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** No global credential aggregation: only one explicitly opted-in matching model is eligible. */
export function resolveGoogleFailoverPool(models: PoolModel[], body: Buffer): PoolModel | undefined {
  const parsed = parsedRequest(body);
  if (typeof parsed?.model !== 'string') return undefined;
  const upstream = parsed.model.replace(/^models\//, '');
  const matches = models.filter(
    (model) =>
      model.enabled !== false &&
      model.provider === 'google-cloudcode' &&
      model.googlePool?.nativeFailoverEnabled === true &&
      (model.externalModelName || model.name).replace(/^models\//, '') === upstream &&
      model.googleAccounts?.some((account) => account.enabled !== false),
  );
  // Even similar pools may have different projects or policies. Let the user choose one explicitly.
  return matches.length === 1 ? matches[0] : undefined;
}

/** HTTP 400/403 require a structured, explicit Google rate-limit diagnosis. */
export function isGoogleQuotaFailure(status: number, body: string): boolean {
  if (status === 429) return true;
  if (status !== 400 && status !== 403) return false;
  try {
    const value = JSON.parse(body);
    const error = value?.error || value;
    if (error?.status === 'RESOURCE_EXHAUSTED') return true;
    return (
      Array.isArray(error?.details) &&
      error.details.some(
        (detail: Record<string, unknown>) =>
          detail?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' &&
          typeof detail.reason === 'string' &&
          /^(?:RATE_LIMIT_EXCEEDED|QUOTA_EXCEEDED|QUOTA_EXHAUSTED|DAILY_LIMIT_EXCEEDED|WEEKLY_LIMIT_EXCEEDED)$/.test(
            detail.reason,
          ),
      )
    );
  } catch {
    return false;
  }
}

/** Retry matching native Google requests only before downstream response headers are sent. */
export async function attemptGooglePoolFailover(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  reqBody: Buffer,
  errorRes: http.IncomingMessage,
  errorBody: string,
  options: PoolFailoverOptions,
  nativeSubagent?: NativeSubagentRouting,
  cloudCodeOrigin = 'https://daily-cloudcode-pa.googleapis.com',
): Promise<boolean> {
  const unavailable = () => res.destroyed || res.writableEnded || options.isStopping?.();
  if (unavailable()) return true;
  // Public Gemini and Cloud Code use different request/response envelopes. Only native
  // Cloud Code requests can be replayed without a complete protocol adapter.
  if (!/^\/v1internal:(?:streamGenerateContent|generateContent)(?:\?|$)/.test(req.url || '')) return false;
  if (!isGoogleQuotaFailure(errorRes.statusCode || 500, errorBody)) return false;
  const pool = resolveGoogleFailoverPool(options.loadCustomModels(), reqBody);
  const body = parsedRequest(reqBody);
  if (!pool || !body || typeof body.model !== 'string') return false;
  const upstreamModel = body.model.replace(/^models\//, '');
  const originalToken = String(req.headers.authorization || '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  const failingAccount = pool.googleAccounts!.find((account) => account.accessToken === originalToken);
  const decision = classifyGoogleRateLimit(errorBody, errorRes.headers['retry-after']);
  if (failingAccount)
    recordGoogleAccountFailure(
      {
        ...failingAccount,
        project: typeof body.project === 'string' ? body.project : undefined,
        cloudCodeEndpoint: undefined,
      },
      errorRes.statusCode!,
      decision.retryAfterMs ?? pool.googlePool?.cooldownMs,
      upstreamModel,
      decision.reason,
      cloudCodeOrigin,
    );
  let candidates = pool.googleAccounts!.filter(
    (account) => account.enabled !== false && account.id !== failingAccount?.id,
  );
  if (!candidates.length) return false;
  const identity =
    typeof body.sessionId === 'string'
      ? body.sessionId
      : typeof body.conversationId === 'string'
        ? body.conversationId
        : undefined;
  const controller = new AbortController();
  const cancel = () => {
    if (!res.writableFinished) controller.abort();
  };
  res.once('close', cancel);
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? pool.retryBudgetMs ?? pool.timeout ?? 60_000,
  );
  let abandonAcquire: (() => void) | undefined;
  try {
    const maximum = Math.min(3, candidates.length);
    for (let attempt = 0; attempt < maximum && candidates.length; attempt++) {
      if (unavailable() || controller.signal.aborted) return !!unavailable();
      let lease: GoogleAccountLease | undefined;
      // Refresh can be shared by other requests. Cancel our waiter without cancelling their refresh.
      try {
        lease = await new Promise<GoogleAccountLease | undefined>((resolve, reject) => {
          let abandoned = false;
          const cancelAcquire = () => {
            abandoned = true;
            resolve(undefined);
          };
          abandonAcquire = cancelAcquire;
          controller.signal.addEventListener('abort', cancelAcquire, { once: true });
          void acquireGoogleAccount(
            pool.name,
            candidates,
            pool.googlePool,
            identity,
            upstreamModel,
            pool.apiUrl || cloudCodeOrigin,
          ).then(
            (value) => {
              controller.signal.removeEventListener('abort', cancelAcquire);
              if (abandoned || unavailable() || controller.signal.aborted) {
                value.release({ cancelled: true });
                resolve(undefined);
              } else resolve(value);
            },
            (error: unknown) => {
              controller.signal.removeEventListener('abort', cancelAcquire);
              reject(error);
            },
          );
        });
      } catch {
        return false;
      } finally {
        abandonAcquire = undefined;
      }
      if (!lease) return !!unavailable();
      if (unavailable() || controller.signal.aborted) {
        lease.release({ cancelled: true });
        return !!unavailable();
      }

      let target: URL;
      let retryBody: Buffer;
      let headers: http.OutgoingHttpHeaders;
      try {
        const origin = googleAccountEndpoint(lease.account, pool.apiUrl || cloudCodeOrigin);
        target = new URL(req.url || '', origin);
        if (
          target.origin !== new URL(origin).origin ||
          !/^\/v1internal:(?:streamGenerateContent|generateContent)$/.test(target.pathname)
        )
          throw new Error('Unsupported native generation path');
        headers = options.forwardingHeaders(req.headers);
        headers.host = target.host;
        headers.authorization = `Bearer ${lease.account.accessToken}`;
        // Never carry the original account's billing project into another account.
        delete headers['x-goog-user-project'];
        const cloned = { ...body };
        delete cloned.project;
        if (lease.account.project) {
          cloned.project = lease.account.project;
          headers['x-goog-user-project'] = lease.account.project;
        }
        retryBody = Buffer.from(JSON.stringify(cloned));
        headers['content-length'] = String(retryBody.length);
        headers['accept-encoding'] = 'identity';
      } catch {
        lease.release({ cancelled: true });
        return false;
      }
      const selectedLease = lease;
      const started = Date.now();
      const handled = await new Promise<boolean>((resolve) => {
        let settled = false;
        let request: http.ClientRequest | undefined;
        let response: http.IncomingMessage | undefined;
        const finish = (handled: boolean, result: Parameters<GoogleAccountLease['release']>[0]) => {
          if (settled) return;
          settled = true;
          controller.signal.removeEventListener('abort', abort);
          selectedLease.release(result);
          resolve(handled);
        };
        const fail = () => {
          if (settled) return;
          const sent = res.headersSent;
          finish(sent || !!unavailable(), { status: 502, cancelled: !!unavailable() });
          if (sent && !res.destroyed && !res.writableEnded) res.destroy();
          response?.destroy();
          request?.destroy();
        };
        const abort = () => {
          if (settled) return;
          const sent = res.headersSent;
          finish(sent || !!unavailable(), { cancelled: true });
          if (sent && !res.destroyed && !res.writableEnded) res.destroy();
          response?.destroy();
          request?.destroy();
        };
        controller.signal.addEventListener('abort', abort, { once: true });
        try {
          request = (options.requestFn || (target.protocol === 'http:' ? http.request : https.request))(
            target,
            { method: req.method, headers },
            (upstream) => {
              response = upstream;
              if (settled || unavailable() || controller.signal.aborted) {
                abort();
                upstream.destroy();
                return;
              }
              upstream.once('error', fail);
              upstream.once('aborted', fail);
              upstream.once('close', () => {
                if (!upstream.complete) fail();
              });
              const status = upstream.statusCode || 502;
              if ([400, 401, 403, 408, 429].includes(status) || status >= 500) {
                const chunks: Buffer[] = [];
                let size = 0;
                upstream.on('data', (chunk: Buffer) => {
                  size += chunk.length;
                  if (size > ERROR_LIMIT) fail();
                  else chunks.push(chunk);
                });
                upstream.once('end', () => {
                  const text = Buffer.concat(chunks).toString('utf8');
                  const limited = isGoogleQuotaFailure(status, text);
                  const limit = limited ? classifyGoogleRateLimit(text, upstream.headers['retry-after']) : undefined;
                  if (status === 400 && !limited) {
                    res.writeHead(status, options.forwardingHeaders(upstream.headers));
                    res.end(Buffer.concat(chunks));
                    finish(true, { status });
                    return;
                  }
                  finish(false, { status, retryAfterMs: limit?.retryAfterMs, cooldownReason: limit?.reason });
                });
                return;
              }
              const success = () => finish(true, { status, latencyMs: Date.now() - started });
              if (nativeSubagent) {
                void forwardNativeGeneration(
                  upstream,
                  res,
                  nativeSubagent,
                  target.pathname.includes('streamGenerateContent') || target.searchParams.get('alt') === 'sse',
                ).then(success, fail);
              } else {
                upstream.once('end', success);
                res.writeHead(status, options.forwardingHeaders(upstream.headers));
                upstream.pipe(res);
              }
            },
          );
          request.once('error', fail);
          request.once('close', () => {
            if (!response || !response.complete) fail();
          });
          options.trackUpstream?.(request);
          if (controller.signal.aborted || unavailable()) abort();
          if (!settled) request.end(retryBody);
        } catch {
          fail();
        }
      });
      if (handled) return true;
      candidates = candidates.filter((account) => account.id !== selectedLease.account.id);
    }
    return false;
  } finally {
    clearTimeout(timeout);
    res.off('close', cancel);
    abandonAcquire?.();
  }
}
