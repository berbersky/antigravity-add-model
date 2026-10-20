import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import { once } from 'node:events';
import {
  attemptGooglePoolFailover,
  isGoogleQuotaFailure,
  resolveGoogleFailoverPool,
  type PoolFailoverOptions,
} from '../proxy/googlePoolFailover';
import { getGooglePoolStatus, resetGoogleAccountState } from '../googleAccounts';

const servers: http.Server[] = [];
const clients: http.ClientRequest[] = [];
const quotaError = JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } });
type Pool = ReturnType<PoolFailoverOptions['loadCustomModels']>[number];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  resetGoogleAccountState();
});

async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function pool(apiUrl = 'https://daily-cloudcode-pa.googleapis.com'): Pool {
  return {
    name: 'models/my-work',
    provider: 'google-cloudcode',
    externalModelName: 'gemini-pro',
    apiUrl,
    googlePool: { nativeFailoverEnabled: true, maxConcurrency: 1 },
    googleAccounts: [
      { id: 'first', accessToken: 'token-first', project: 'standby-project' },
      { id: 'second', accessToken: 'token-second' },
    ],
  };
}
async function gateway(models: Pool[], options: Partial<PoolFailoverOptions> = {}, originalStatus = 429) {
  const completions: Promise<boolean>[] = [];
  const origin = await serve((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const operation = attemptGooglePoolFailover(
        req,
        res,
        Buffer.concat(chunks),
        { statusCode: originalStatus, headers: {} } as http.IncomingMessage,
        quotaError,
        {
          loadCustomModels: () => models,
          forwardingHeaders: (headers) => {
            const result = { ...headers };
            delete result.connection;
            delete result['transfer-encoding'];
            return result;
          },
          timeoutMs: 1000,
          ...options,
        },
      );
      completions.push(operation);
      void operation.then((handled) => {
        if (!handled && !res.destroyed && !res.writableEnded) {
          res.writeHead(429);
          res.end(quotaError);
        }
      });
    });
  });
  return { origin, completions };
}
function send(origin: string, model = 'gemini-pro', path = '/v1internal:streamGenerateContent?alt=sse') {
  let outgoing!: http.ClientRequest;
  const response = new Promise<http.IncomingMessage>((resolve, reject) => {
    outgoing = http.request(
      `${origin}${path}`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer original', 'x-goog-user-project': 'original-project' },
      },
      resolve,
    );
    outgoing.on('error', reject);
    outgoing.end(JSON.stringify({ model, project: 'original-project' }));
    clients.push(outgoing);
  });
  return { request: outgoing, response };
}
async function text(response: http.IncomingMessage) {
  let value = '';
  for await (const chunk of response) value += chunk.toString();
  return value;
}

describe('native Google account failover', () => {
  it('requires one explicit matching pool and never combines unrelated models', () => {
    const configured = pool();
    const body = Buffer.from('{"model":"models/gemini-pro"}');
    expect(resolveGoogleFailoverPool([configured], body)).toBe(configured);
    expect(resolveGoogleFailoverPool([{ ...configured, googlePool: {} }], body)).toBeUndefined();
    expect(resolveGoogleFailoverPool([{ ...configured, enabled: false }], body)).toBeUndefined();
    expect(resolveGoogleFailoverPool([{ ...configured, externalModelName: 'claude-sonnet' }], body)).toBeUndefined();
    expect(resolveGoogleFailoverPool([configured, { ...configured, name: 'models/duplicate' }], body)).toBeUndefined();
    expect(resolveGoogleFailoverPool([{ ...configured, externalModelName: 'gemini-flash' }], body)).toBeUndefined();
    expect(
      resolveGoogleFailoverPool(
        [{ ...configured, externalModelName: 'gpt-oss' }],
        Buffer.from('{"model":"claude-sonnet"}'),
      ),
    ).toBeUndefined();
  });
  it('recognizes only structured quota diagnoses for HTTP 400', () => {
    expect(isGoogleQuotaFailure(400, quotaError)).toBe(true);
    expect(isGoogleQuotaFailure(400, '{"error":{"message":"Prompt contains: quota exceeded"}}')).toBe(false);
    expect(
      isGoogleQuotaFailure(400, '{"error":{"status":"INVALID_ARGUMENT"},"request":{"prompt":"quota exceeded"}}'),
    ).toBe(false);
  });

  it('keeps public Gemini requests closed instead of replaying an incompatible Cloud Code envelope', async () => {
    const requestFn = vi.fn(() => {
      throw new Error('Public request must not be replayed');
    });
    const fixture = await gateway([pool()], { requestFn: requestFn as unknown as typeof http.request });
    const response = await send(fixture.origin, 'gemini-pro', '/v1beta/models/gemini-pro:generateContent').response;
    expect(response.statusCode).toBe(429);
    await text(response);
    expect(requestFn).not.toHaveBeenCalled();
    expect(getGooglePoolStatus()).toEqual([]);
  });

  it('recovers from quota HTTP 400 and keeps the exhausted standby out of subsequent attempts', async () => {
    const attempted: string[] = [];
    const upstream = await serve((req, res) => {
      attempted.push(req.headers.authorization!);
      if (req.headers.authorization === 'Bearer token-first') {
        res.writeHead(400);
        res.end(
          JSON.stringify({
            error: { status: 'RESOURCE_EXHAUSTED', message: 'Individual quota exceeded. Resets in 1h.' },
          }),
        );
      } else res.end('recovered');
    });
    const fixture = await gateway([pool(upstream)], {}, 400);
    expect(await text(await send(fixture.origin).response)).toBe('recovered');
    expect(await text(await send(fixture.origin).response)).toBe('recovered');
    expect(attempted).toEqual(['Bearer token-first', 'Bearer token-second', 'Bearer token-second']);
    expect(getGooglePoolStatus().find((account) => account.id === 'first')).toMatchObject({
      status: 'cooldown',
      modelCooldowns: [{ modelName: 'gemini-pro', reason: 'quota-exhausted' }],
    });
  });

  it('returns a standby validation error without retrying another account', async () => {
    let attempts = 0;
    const upstream = await serve((_req, res) => {
      attempts++;
      res.writeHead(400);
      res.end('{"error":{"status":"INVALID_ARGUMENT","message":"invalid schema"}}');
    });
    const fixture = await gateway([pool(upstream)]);
    const response = await send(fixture.origin).response;
    expect(response.statusCode).toBe(400);
    expect(await text(response)).toContain('INVALID_ARGUMENT');
    expect(attempts).toBe(1);
  });

  it('distinguishes explicit quota 403 from permission errors mentioning quota', () => {
    expect(isGoogleQuotaFailure(403, quotaError)).toBe(true);
    expect(isGoogleQuotaFailure(403, '{"error":{"message":"Permission denied to inspect quota"}}')).toBe(false);
    expect(
      isGoogleQuotaFailure(
        403,
        '{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"RATE_LIMIT_EXCEEDED"}]}}',
      ),
    ).toBe(true);
    expect(isGoogleQuotaFailure(429, 'unavailable')).toBe(true);
  });

  it('uses only the chosen pool and replaces both project fields with the standby account', async () => {
    let received: { auth?: string; project?: string; body?: string } = {};
    const upstream = await serve((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        received = { auth: req.headers.authorization, project: req.headers['x-goog-user-project'] as string, body };
        res.end('done');
      });
    });
    const selected = pool(upstream);
    selected.googlePool!.preferredAccountId = 'second';
    const unrelated = { ...pool(upstream), name: 'models/other', externalModelName: 'claude-sonnet' };
    const fixture = await gateway([unrelated, selected]);
    const response = await send(fixture.origin).response;
    expect(await text(response)).toBe('done');
    expect(received.auth).toBe('Bearer token-second');
    expect(received.project).toBeUndefined();
    expect(JSON.parse(received.body!)).not.toHaveProperty('project');
    expect(getGooglePoolStatus().find((account) => account.id === 'second')).toMatchObject({
      inFlight: 0,
      succeeded: 1,
    });
  });

  it('keeps the lease for the full SSE stream and enforces maxConcurrency', async () => {
    let streaming!: http.ServerResponse;
    const upstream = await serve((_req, res) => {
      streaming = res;
      res.writeHead(200);
      res.write('data: first\n\n');
    });
    const selected = pool(upstream);
    selected.googleAccounts = selected.googleAccounts!.slice(0, 1);
    const fixture = await gateway([selected]);
    const first = await send(fixture.origin).response;
    expect(getGooglePoolStatus()[0].inFlight).toBe(1);
    const second = await send(fixture.origin).response;
    expect(second.statusCode).toBe(429);
    await text(second);
    expect(getGooglePoolStatus()[0].inFlight).toBe(1);
    streaming.end('data: end\n\n');
    expect(await text(first)).toContain('data: end');
    expect(getGooglePoolStatus()[0]).toMatchObject({ inFlight: 0, succeeded: 1 });
  });

  it('releases and retries after an aborted standby error body', async () => {
    const attempted: string[] = [];
    const upstream = await serve((req, res) => {
      attempted.push(req.headers.authorization!);
      if (req.headers.authorization === 'Bearer token-first') {
        res.writeHead(429, { 'content-length': '1000' });
        res.write('{"error":');
        setImmediate(() => res.socket?.destroy());
      } else res.end('recovered');
    });
    const fixture = await gateway([pool(upstream)]);
    expect(await text(await send(fixture.origin).response)).toBe('recovered');
    expect(attempted).toEqual(['Bearer token-first', 'Bearer token-second']);
    expect(getGooglePoolStatus().every((account) => account.inFlight === 0)).toBe(true);
  });

  it('bounds a standby that never returns headers and releases its lease', async () => {
    const upstream = await serve(() => {});
    const track = vi.fn();
    const fixture = await gateway([pool(upstream)], { timeoutMs: 40, trackUpstream: track });
    const response = await send(fixture.origin).response;
    expect(response.statusCode).toBe(429);
    await text(response);
    expect(track).toHaveBeenCalledOnce();
    expect((track.mock.calls[0][0] as http.ClientRequest).destroyed).toBe(true);
    expect(getGooglePoolStatus().every((account) => account.inFlight === 0)).toBe(true);
  });

  it('cancels an active standby stream when the downstream disconnects', async () => {
    const upstream = await serve((_req, res) => {
      res.writeHead(200);
      res.write('data: first\n\n');
    });
    const track = vi.fn();
    const fixture = await gateway([pool(upstream)], { trackUpstream: track });
    const call = send(fixture.origin);
    const response = await call.response;
    response.destroy();
    await fixture.completions[0];
    expect(getGooglePoolStatus().every((account) => account.inFlight === 0)).toBe(true);
    expect((track.mock.calls[0][0] as http.ClientRequest).destroyed).toBe(true);
  });

  it('does not start another standby when the tracked request is stopped during shutdown', async () => {
    const upstream = await serve(() => {});
    let stopping = false;
    let tracked!: http.ClientRequest;
    const fixture = await gateway([pool(upstream)], {
      trackUpstream: (request) => {
        tracked = request;
      },
      isStopping: () => stopping,
    });
    const call = send(fixture.origin);
    void call.response.catch(() => {});
    await vi.waitFor(() => expect(tracked).toBeDefined());
    stopping = true;
    tracked.destroy();
    expect(await fixture.completions[0]).toBe(true);
    call.request.destroy();
    expect(getGooglePoolStatus().every((account) => account.inFlight === 0)).toBe(true);
    expect(getGooglePoolStatus().filter((account) => account.requests > 0)).toHaveLength(1);
  });
});
