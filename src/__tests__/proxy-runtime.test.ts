import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { CustomModel } from '../proxy';
import { buildFallbackChain, getProxyMetrics, runCustomModelRequest, stopCustomRequests } from '../proxy/customRequest';
import { stopCleanupInterval } from '../proxy/shared';
import { CircuitBreaker } from '../proxy/circuitBreaker';
import { applyRequestOptions, parseRetryAfter, trimContext } from '../proxy/requestOptions';
import { getGoogleApiUrl } from '../proxy/translators/google';
import { getProviderHeaders, getProviderUrl, getTranslator, translateRequest } from '../proxy/registry';
import { getProvider, PROVIDERS, resolveApiFormat } from '../providers';
import { validateCustomModel } from '../schemaValidator';
import { getGooglePoolStatus, resetGoogleAccountState } from '../googleAccounts';
import { clearDiagnostics, getDiagnostics } from '../diagnostics';
import type { GeminiBody } from '../proxy/requestOptions';

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const servers: http.Server[] = [];
afterEach(async () => {
  stopCustomRequests();
  resetGoogleAccountState();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
afterAll(stopCleanupInterval);

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function model(apiUrl: string, fields: Partial<CustomModel> = {}): CustomModel {
  return {
    name: `models/${randomUUID()}`,
    displayName: 'test',
    description: '',
    provider: 'openai',
    apiKey: 'secret-test-token',
    externalModelName: 'test-model',
    apiUrl,
    maxRetries: 0,
    ...fields,
  };
}
function success(res: http.ServerResponse, text = 'OK') {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
}
async function proxy(models: CustomModel[], stream = false, cloud = false): Promise<string> {
  return serve((req, res) => {
    void runCustomModelRequest(
      res,
      models[0],
      { contents: [{ role: 'user', parts: [{ text: req.url || 'hello' }] }] },
      stream,
      models,
      cloud,
    );
  });
}
async function body(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const sse = (res: http.ServerResponse, value: unknown) =>
  res.write(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);

function toolReply(
  res: http.ServerResponse,
  provider: 'openai' | 'anthropic' | 'google',
  stream: boolean,
  name: string,
  args: Record<string, unknown>,
) {
  if (provider === 'google') {
    const reply = {
      candidates: [
        {
          content: { role: 'model', parts: [{ functionCall: { id: 'shared-call', name, args } }] },
          finishReason: 'STOP',
        },
      ],
    };
    res.setHeader('Content-Type', stream ? 'text/event-stream' : 'application/json');
    if (stream) sse(res, reply);
    else res.write(JSON.stringify(reply));
    res.end();
    return;
  }
  if (!stream) {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        provider === 'openai'
          ? {
              choices: [
                {
                  message: {
                    tool_calls: [
                      { id: 'shared-call', type: 'function', function: { name, arguments: JSON.stringify(args) } },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }
          : {
              id: 'shared-message',
              type: 'message',
              content: [{ type: 'tool_use', id: 'shared-call', name, input: args }],
              stop_reason: 'tool_use',
            },
      ),
    );
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  if (provider === 'openai') {
    sse(res, {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'shared-call', type: 'function', function: { name, arguments: JSON.stringify(args) } },
            ],
          },
        },
      ],
    });
    sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    sse(res, '[DONE]');
  } else {
    sse(res, { type: 'message_start', message: { id: 'shared-message' } });
    sse(res, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'shared-call', name, input: {} },
    });
    sse(res, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) },
    });
    sse(res, { type: 'content_block_stop', index: 0 });
    sse(res, { type: 'message_delta', delta: { stop_reason: 'tool_use' } });
    sse(res, { type: 'message_stop' });
  }
  res.end();
}

async function readToolCalls(response: Response, stream: boolean) {
  type ToolCall = { id?: string; name: string; args: Record<string, unknown> };
  type Payload = { candidates?: { content?: { parts?: { functionCall?: ToolCall }[] } }[] };
  const payloads: Payload[] = stream
    ? (await response.text())
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)))
    : [await response.json()];
  return payloads
    .flatMap((payload) => payload.candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .flatMap((part) => (part.functionCall ? [part.functionCall] : []));
}

// Native IDE context and optional artifact schema, reduced to the relevant fields.
function artifactRequest(workspace = 'C:\\repo', artifactRoot = 'C:\\profile\\brain\\conversation'): GeminiBody {
  return {
    sessionId: 'artifact-session',
    contents: [{ role: 'user', parts: [{ text: 'Create the requested file.' }] }],
    systemInstruction: {
      parts: [
        {
          text: [
            'The user has 1 active workspaces, each defined by a URI and a CorpusName. Multiple URIs potentially map to the same CorpusName. The mapping is shown as follows in the format [URI] -> [CorpusName]:',
            `${workspace} -> fixture/repository`,
            '',
            '<artifacts>',
            `Artifact Directory Path: ${artifactRoot}`,
            '</artifacts>',
          ].join('\n'),
        },
      ],
    },
    tools: [
      {
        functionDeclarations: [
          {
            name: 'write_to_file',
            description:
              'Use this tool to create new files. When creating an artifact, always provide an ArtifactMetadata.',
            parameters: {
              type: 'OBJECT',
              properties: {
                TargetFile: { type: 'STRING' },
                CodeContent: { type: 'STRING' },
                Overwrite: { type: 'BOOLEAN' },
                Description: { type: 'STRING' },
                toolSummary: { type: 'STRING' },
                toolAction: { type: 'STRING' },
                ArtifactMetadata: {
                  type: 'OBJECT',
                  description: 'Metadata that defines artifact properties. Required when creating an artifact file.',
                  properties: {
                    Summary: { type: 'STRING' },
                    UserFacing: { type: 'BOOLEAN' },
                    RequestFeedback: { type: 'BOOLEAN' },
                  },
                  required: ['Summary', 'UserFacing', 'RequestFeedback'],
                },
              },
              required: ['TargetFile', 'CodeContent', 'Overwrite', 'Description', 'toolSummary', 'toolAction'],
            },
          },
        ],
      },
    ],
  };
}

function artifactWriteArgs(target = 'C:\\repo\\result.txt') {
  return {
    TargetFile: target,
    CodeContent: 'verified result',
    Overwrite: false,
    Description: 'Save the requested result.',
    toolAction: 'Writing result',
    toolSummary: 'Fixture result',
    ArtifactMetadata: { Summary: 'Result', UserFacing: false, RequestFeedback: false },
  };
}

describe('real upstream HTTP routing', () => {
  describe.each(['openai', 'anthropic', 'google'] as const)('%s native artifact metadata', (provider) => {
    it.each([
      { stream: false, upstreamStream: false, target: 'C:\\repo\\result.txt', ordinary: true },
      { stream: true, upstreamStream: true, target: 'C:\\repo\\result.txt', ordinary: true },
      { stream: true, upstreamStream: false, target: 'C:\\repo\\result.txt', ordinary: true },
      { stream: false, upstreamStream: false, target: 'C:\\profile\\brain\\conversation\\plan.md', ordinary: false },
      { stream: true, upstreamStream: true, target: 'C:\\profile\\brain\\conversation\\plan.md', ordinary: false },
      { stream: true, upstreamStream: false, target: 'C:\\profile\\brain\\conversation\\plan.md', ordinary: false },
    ])(
      'handles metadata for $target (client stream=$stream, upstream stream=$upstreamStream)',
      async ({ stream, upstreamStream, target, ordinary }) => {
        const args = artifactWriteArgs(target);
        const upstream = await serve((_req, res) => toolReply(res, provider, upstreamStream, 'write_to_file', args));
        const configured = model(upstream, { provider });
        const request = artifactRequest();
        const before = structuredClone(request);
        const url = await serve(
          (_req, res) => void runCustomModelRequest(res, configured, request, stream, [configured], false),
        );
        const response = await fetch(url);
        expect(response.status).toBe(200);
        const expected: Record<string, unknown> = { ...args };
        if (ordinary) delete expected.ArtifactMetadata;
        expect(await readToolCalls(response, stream)).toEqual([
          { id: 'shared-call', name: 'write_to_file', args: expected },
        ]);
        expect(request).toEqual(before);
      },
    );
  });

  it.each([false, true])(
    'replays reasoning for the corrected call on the next native turn (stream=%s)',
    async (stream) => {
      const args = artifactWriteArgs();
      const reasoning = 'Retain the verified result and read it back after saving.';
      const captured: {
        messages: {
          role: string;
          reasoning_content?: string;
          tool_call_id?: string;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
        }[];
      }[] = [];
      const upstream = await serve(async (req, res) => {
        captured.push(await body(req));
        if (captured.length > 1) return success(res, 'continued');
        const call = {
          id: 'artifact-call',
          type: 'function',
          function: { name: 'write_to_file', arguments: JSON.stringify(args) },
        };
        res.setHeader('Content-Type', stream ? 'text/event-stream' : 'application/json');
        if (stream) {
          sse(res, { choices: [{ delta: { reasoning_content: reasoning }, finish_reason: null }] });
          sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: 'tool_calls' }] });
          sse(res, '[DONE]');
        } else {
          res.write(
            JSON.stringify({
              choices: [{ message: { reasoning_content: reasoning, tool_calls: [call] }, finish_reason: 'tool_calls' }],
            }),
          );
        }
        res.end();
      });
      const configured = model(upstream);
      const url = await serve(async (req, res) => {
        void runCustomModelRequest(res, configured, await body(req), stream, [configured], false);
      });
      const request = artifactRequest();
      const first = await fetch(url, { method: 'POST', body: JSON.stringify(request) });
      expect(first.status).toBe(200);
      const [call] = await readToolCalls(first, stream);
      expect(call.args).not.toHaveProperty('ArtifactMetadata');
      const continuation = {
        ...request,
        contents: [
          ...request.contents!,
          { role: 'model', parts: [{ functionCall: call }] },
          {
            role: 'user',
            parts: [{ functionResponse: { id: call.id, name: call.name, response: { result: 'File saved.' } } }],
          },
        ],
      };
      const next = await fetch(url, { method: 'POST', body: JSON.stringify(continuation) });
      expect(next.status).toBe(200);
      expect(await next.text()).toContain('continued');
      const assistant = captured[1].messages.find((message) => message.role === 'assistant');
      const result = captured[1].messages.find((message) => message.role === 'tool');
      expect(assistant?.reasoning_content).toBe(reasoning);
      const replayedCall = assistant?.tool_calls?.[0];
      expect(replayedCall?.id).toBe(call.id);
      expect(JSON.parse(replayedCall!.function.arguments)).toEqual(call.args);
      expect(result?.tool_call_id).toBe(call.id);
    },
  );

  it('isolates artifact roots across simultaneous requests on the same model', async () => {
    const pending: http.ServerResponse[] = [];
    const args = artifactWriteArgs('C:\\repo\\artifacts\\plan.md');
    const upstream = await serve((_req, res) => {
      pending.push(res);
      if (pending.length === 2)
        for (const response of pending.reverse()) toolReply(response, 'openai', true, 'write_to_file', args);
    });
    const configured = model(upstream);
    const url = await serve(async (req, res) => {
      void runCustomModelRequest(res, configured, await body(req), true, [configured], false);
    });
    const responses = await Promise.all(
      [
        artifactRequest('C:\\repo', 'C:\\profile\\brain\\conversation'),
        artifactRequest('C:\\repo', 'C:\\repo\\artifacts'),
      ].map(async (request) => {
        const response = await fetch(url, { method: 'POST', body: JSON.stringify(request) });
        expect(response.status).toBe(200);
        return readToolCalls(response, true);
      }),
    );
    expect(responses[0][0].args).not.toHaveProperty('ArtifactMetadata');
    expect(responses[1][0].args).toEqual(args);
  });

  describe('terminal OpenAI tool frames', () => {
    it.each([
      { name: 'ordinary less-than sign', content: '2 <', text: '2 <', calls: [] },
      { name: 'ordinary partial marker', content: 'Literal <DS', text: 'Literal <DS', calls: [] },
      {
        name: 'DSML call',
        content:
          '<DSML|invoke name="lookup"><DSML|parameter name="value" string="true">result</DSML|parameter></DSML|invoke>',
        text: '',
        calls: [{ name: 'lookup', args: { value: 'result' } }],
      },
    ])('flushes $name when only [DONE] signals completion', async ({ content, text, calls }) => {
      const upstream = await serve((_req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        sse(res, { choices: [{ delta: { content } }] });
        sse(res, '[DONE]');
        sse(res, '[DONE]');
        res.end();
      });
      const response = await fetch(await proxy([model(upstream)], true));
      expect(response.status).toBe(200);
      const wire = await response.clone().text();
      const candidates = wire
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .flatMap((line) => JSON.parse(line.slice(6)).candidates || []);
      const rendered = candidates
        .flatMap((candidate: { content: { parts: { text?: string }[] } }) => candidate.content.parts)
        .map((part: { text?: string }) => part.text || '')
        .join('');
      expect(rendered).toBe(text);
      expect(wire.match(/"finishReason":"STOP"/g)).toHaveLength(1);
      expect(await readToolCalls(response, true)).toEqual(calls);
    });

    it.each(['{"value":"result"}', '{"value":'])('validates pending arguments %s before [DONE] flush', async (args) => {
      const upstream = await serve((_req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        sse(res, {
          choices: [
            { delta: { tool_calls: [{ index: 0, id: 'done-call', function: { name: 'lookup', arguments: args } }] } },
          ],
        });
        sse(res, '[DONE]');
        res.end();
      });
      const response = await fetch(await proxy([model(upstream)], true));
      if (args.endsWith('}')) {
        expect(response.status).toBe(200);
        expect(await readToolCalls(response, true)).toEqual([
          { id: 'done-call', name: 'lookup', args: { value: 'result' } },
        ]);
      } else {
        expect(response.status).toBe(502);
        expect(await response.text()).toContain('incomplete tool arguments');
      }
    });

    it.each([
      { finish: 'tool_calls', indices: [0] },
      { finish: 'tool_calls', indices: [7, 2] },
      { finish: 'stop', indices: [4] },
    ])('completes final fragments once for $finish with indices $indices', async ({ finish, indices }) => {
      const upstream = await serve((_req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        sse(res, {
          choices: [
            {
              delta: {
                tool_calls: indices.map((index) => ({
                  index,
                  id: `call-${index}`,
                  function: { name: 'lookup', arguments: '{"value":' },
                })),
              },
            },
          ],
        });
        sse(res, {
          choices: [
            {
              delta: {
                tool_calls: [...indices].reverse().map((index) => ({
                  index,
                  function: { arguments: JSON.stringify(`result-${index}`) + '}' },
                })),
              },
              finish_reason: finish,
            },
          ],
        });
        sse(res, '[DONE]');
        res.end();
      });
      const response = await fetch(await proxy([model(upstream)], true));
      expect(response.status).toBe(200);
      const calls = await readToolCalls(response, true);
      expect(calls).toHaveLength(indices.length);
      expect(calls).toEqual(
        expect.arrayContaining(
          indices.map((index) => ({
            id: `call-${index}`,
            name: 'lookup',
            args: { value: `result-${index}` },
          })),
        ),
      );
    });

    it('combines repeated final fragments and a new whole call in the same frame', async () => {
      const upstream = await serve((_req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        sse(res, {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 4,
                    id: 'existing',
                    function: { name: 'lookup', arguments: '{"value":' },
                  },
                ],
              },
            },
          ],
        });
        sse(res, {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 9, id: 'new', function: { name: 'lookup', arguments: '{"value":"new"}' } },
                  { index: 4, function: { arguments: '"old"' } },
                  { index: 4, function: { arguments: '}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        });
        sse(res, '[DONE]');
        res.end();
      });
      const response = await fetch(await proxy([model(upstream)], true));
      expect(response.status).toBe(200);
      expect(await readToolCalls(response, true)).toEqual([
        { id: 'existing', name: 'lookup', args: { value: 'old' } },
        { id: 'new', name: 'lookup', args: { value: 'new' } },
      ]);
    });

    it('preserves reasoning, text and the completed call from one terminal event', async () => {
      const upstream = await serve((_req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        sse(res, {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'reasoned-call',
                    function: { name: 'lookup', arguments: '{"value":' },
                  },
                ],
              },
            },
          ],
        });
        sse(res, {
          choices: [
            {
              delta: {
                reasoning_content: 'Ready to look up the value.',
                content: 'Checking now.',
                tool_calls: [{ index: 0, function: { arguments: '"result"}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        });
        sse(res, '[DONE]');
        res.end();
      });
      const response = await fetch(await proxy([model(upstream)], true));
      const text = await response.clone().text();
      expect(response.status).toBe(200);
      expect(text).toContain('"text":"Ready to look up the value.","thought":true');
      expect(text).toContain('"text":"Checking now."');
      expect(text).not.toContain('TOOL_CALL');
      expect(text.match(/"finishReason":"STOP"/g)).toHaveLength(1);
      expect(await readToolCalls(response, true)).toEqual([
        { id: 'reasoned-call', name: 'lookup', args: { value: 'result' } },
      ]);
    });

    it.each(['{"value":}', 'null', '[]', '"scalar"'])(
      'rejects terminal-only invalid arguments %s before emitting any call',
      async (invalid) => {
        let requests = 0;
        let fallbacks = 0;
        const upstream = await serve((_req, res) => {
          requests++;
          res.setHeader('Content-Type', 'text/event-stream');
          sse(res, { choices: [{ delta: { content: 'Checking.' } }] });
          sse(res, {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'valid', function: { name: 'lookup', arguments: '{"value":"valid"}' } },
                    { index: 1, id: 'invalid', function: { name: 'lookup', arguments: invalid } },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          });
          sse(res, '[DONE]');
          res.end();
        });
        const fallback = model(
          await serve((_req, res) => {
            fallbacks++;
            success(res);
          }),
        );
        const configured = model(upstream, { maxRetries: 2, fallbackModels: [fallback.name] });
        const text = await (await fetch(await proxy([configured, fallback], true))).text();
        expect(text).toContain('event: error');
        expect(text).not.toContain('"functionCall"');
        expect(requests).toBe(1);
        expect(fallbacks).toBe(0);
      },
    );

    it('rejects an invalid terminal-only tool stream without retrying or falling back', async () => {
      let requests = 0;
      let fallbacks = 0;
      const upstream = await serve((_req, res) => {
        requests++;
        res.setHeader('Content-Type', 'text/event-stream');
        sse(res, {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    function: { name: 'lookup', arguments: '{"value":}' },
                    id: 'invalid',
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        });
        sse(res, '[DONE]');
        res.end();
      });
      const fallback = model(
        await serve((_req, res) => {
          fallbacks++;
          success(res);
        }),
      );
      const configured = model(upstream, { maxRetries: 2, fallbackModels: [fallback.name] });
      const response = await fetch(await proxy([configured, fallback], true));
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain('"functionCall"');
      expect(requests).toBe(1);
      expect(fallbacks).toBe(0);
    });
  });

  it.each([400, 422])(
    'explains an upstream HTTP %i tool-schema rejection without exposing its body',
    async (status) => {
      let attempts = 0;
      const upstream = await serve((_req, res) => {
        attempts++;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message:
                "Tool 18 function has invalid 'parameters' schema: '1' is not of type 'integer'. On schema['properties']['ServerName']['minLength']: '1'. Echo: secret-test-token private-user-file-content",
              echoedKey: 'secret-test-token',
              privateContent: 'private-user-file-content',
            },
          }),
        );
      });
      const response = await fetch(await proxy([model(upstream, { maxRetries: 2 })]));
      const text = await response.text();
      expect(response.status).toBe(status);
      expect(attempts).toBe(1);
      expect(text).toContain('Tool schema rejected');
      expect(text).toContain('minLength');
      expect(text).not.toContain('secret-test-token');
      expect(text).not.toContain('private-user-file-content');
      expect(text).not.toContain('ServerName');
    },
  );

  it.each([1, 1000])(
    'bounds incomplete upstream error bodies (%i chunks) and preserves the original status',
    async (chunks) => {
      const upstream = await serve((_req, res) => {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.write('private-user-file-content '.repeat(chunks));
        // Deliberately never end: error diagnostics must not wait for an unlimited body.
      });
      const response = await fetch(await proxy([model(upstream, { idleTimeout: 10000 })]), {
        signal: AbortSignal.timeout(3000),
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('{"error":{"message":"Upstream returned HTTP 400."}}');
    },
  );

  it.each([false, true])(
    'normalizes Workers AI tool schemas over HTTP and returns a function call (stream=%s)',
    async (stream) => {
      const accountPath = `/client/v4/accounts/${'a'.repeat(32)}/ai/v1/chat/completions`;
      let forwardedUrl: string | undefined;
      let forwardedAuthorization: string | undefined;
      let forwarded:
        | {
            model: string;
            tools: {
              function: { parameters: { properties: { ServerName: { type: string; minLength: string | number } } } };
            }[];
          }
        | undefined;
      const upstream = await serve(async (req, res) => {
        forwardedUrl = req.url;
        forwardedAuthorization = req.headers.authorization;
        forwarded = await body(req);
        if (forwarded!.tools[0].function.parameters.properties.ServerName.minLength !== 1) {
          res.writeHead(400);
          res.end('Tool function has invalid parameters schema: minLength must be an integer');
          return;
        }
        toolReply(res, 'openai', stream, 'list_resources', { ServerName: 'workspace' });
      });
      const configured = model(`${upstream}${accountPath}`, {
        provider: 'workers-ai',
        externalModelName: '@cf/test/tool-model',
      });
      const url = await serve((_req, res) => {
        void runCustomModelRequest(
          res,
          configured,
          {
            contents: [{ role: 'user', parts: [{ text: 'List workspace resources' }] }],
            tools: [
              {
                functionDeclarations: [
                  {
                    name: 'list_resources',
                    parametersJsonSchema: {
                      type: 'OBJECT',
                      properties: { ServerName: { type: 'STRING', minLength: '1' } },
                      required: ['ServerName'],
                    },
                  },
                ],
              },
            ],
          },
          stream,
          [configured],
          false,
        );
      });
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await readToolCalls(response, stream)).toEqual([
        expect.objectContaining({ name: 'list_resources', args: { ServerName: 'workspace' } }),
      ]);
      expect(forwarded?.model).toBe('@cf/test/tool-model');
      expect(forwardedUrl).toBe(accountPath);
      expect(forwardedAuthorization).toBe('Bearer secret-test-token');
      expect(forwarded?.tools[0].function.parameters.properties.ServerName).toEqual({ type: 'string', minLength: 1 });
    },
  );

  it.each([
    { provider: 'openai' as const, stream: false },
    { provider: 'anthropic' as const, stream: true },
  ])(
    'returns file validation feedback to $provider so the next turn can correct the call',
    async ({ provider, stream }) => {
      const errorText = 'File write failed: invalid arguments: additional properties AbsolutePath not allowed';
      const invalidArgs = { AbsolutePath: '/tmp/followup.txt', content: 'hello' };
      const correctedArgs = { path: '/tmp/followup.txt', content: 'hello' };
      const upstreamRequests: { messages: unknown[] }[] = [];
      const upstream = await serve(async (req, res) => {
        const input = await body(req);
        upstreamRequests.push(input);
        const receivedError = JSON.stringify(input.messages).includes(errorText);
        toolReply(res, provider, stream, 'write_file', receivedError ? correctedArgs : invalidArgs);
      });
      const configured = model(upstream, { provider });
      const url = await serve(async (req, res) => {
        const input = await body(req);
        void runCustomModelRequest(res, configured, input, stream, [configured], false);
      });
      const tools = [
        {
          functionDeclarations: [
            {
              name: 'write_file',
              parametersJsonSchema: {
                type: 'object',
                properties: { path: { type: 'string' }, content: { type: 'string' } },
                required: ['path', 'content'],
                additionalProperties: false,
              },
            },
          ],
        },
      ];
      const prompt = { role: 'user', parts: [{ text: 'Write hello to /tmp/followup.txt' }] };
      const request = async (contents: unknown[]) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents, tools }),
        });
        expect(response.status).toBe(200);
        return readToolCalls(response, stream);
      };
      const [firstCall] = await request([prompt]);
      expect(firstCall).toMatchObject({ name: 'write_file', args: invalidArgs });
      const nextCalls = await request([
        prompt,
        { role: 'model', parts: [{ functionCall: firstCall }] },
        {
          role: 'user',
          parts: [{ functionResponse: { id: firstCall.id, name: firstCall.name, response: {} } }, { text: errorText }],
        },
      ]);
      expect(upstreamRequests).toHaveLength(2);
      expect(JSON.stringify(upstreamRequests[1].messages)).toContain(errorText);
      expect(nextCalls).toEqual([expect.objectContaining({ name: 'write_file', args: correctedArgs })]);
    },
  );

  describe.each(['openai', 'anthropic'] as const)('%s tool arguments', (provider) => {
    it.each([
      {
        stream: false,
        name: 'write_to_file',
        args: { TargetFile: '/tmp/output.txt', CodeContent: 'hello', Overwrite: false },
      },
      {
        stream: true,
        name: 'write_to_file',
        args: { TargetFile: '/tmp/output.txt', CodeContent: 'hello', Overwrite: false },
      },
      { stream: false, name: 'write_file', args: { path: '/tmp/output.txt', content: 'hello' } },
      { stream: true, name: 'write_file', args: { path: '/tmp/output.txt', content: 'hello' } },
    ])('preserves declared $name arguments with stream=$stream', async ({ stream, name, args }) => {
      const upstream = await serve((_req, res) => toolReply(res, provider, stream, name, args));
      const configured = model(upstream, { provider });
      const request = {
        contents: [{ role: 'user', parts: [{ text: 'write a file' }] }],
        tools: [
          {
            functionDeclarations: [
              {
                name,
                parametersJsonSchema: {
                  type: 'object',
                  properties: Object.fromEntries(
                    Object.entries(args).map(([key, value]) => [key, { type: typeof value }]),
                  ),
                  required: Object.keys(args),
                  additionalProperties: false,
                },
              },
            ],
          },
        ],
      };
      const url = await serve(
        (_req, res) => void runCustomModelRequest(res, configured, request, stream, [configured], false),
      );
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await readToolCalls(response, stream)).toEqual([expect.objectContaining({ name, args })]);
    });

    it('isolates live schemas for simultaneous streams on the same model', async () => {
      const pending: { res: http.ServerResponse; token: string }[] = [];
      const upstream = await serve(async (req, res) => {
        const token = JSON.stringify(await body(req)).includes('first-request') ? 'first' : 'second';
        pending.push({ res, token });
        if (pending.length === 2) {
          for (const request of pending.reverse()) {
            toolReply(request.res, provider, true, 'write_file', {
              path: `/tmp/${request.token}.txt`,
              content: request.token,
            });
          }
        }
      });
      const configured = model(upstream, { provider });
      const url = await serve(async (req, res) => {
        const request = await body(req);
        void runCustomModelRequest(res, configured, request, true, [configured], false);
      });
      const results = await Promise.all(
        ['first', 'second'].map(async (token) => {
          const pathKey = token === 'first' ? 'path' : 'AbsolutePath';
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: `${token}-request` }] }],
              tools: [
                {
                  functionDeclarations: [
                    {
                      name: 'write_file',
                      parameters: {
                        type: 'OBJECT',
                        properties: { [pathKey]: { type: 'STRING' }, content: { type: 'STRING' } },
                        required: [pathKey, 'content'],
                        additionalProperties: false,
                      },
                    },
                  ],
                },
              ],
            }),
          });
          expect(response.status).toBe(200);
          return readToolCalls(response, true);
        }),
      );
      expect(results[0]).toEqual([
        expect.objectContaining({ name: 'write_file', args: { path: '/tmp/first.txt', content: 'first' } }),
      ]);
      expect(results[1]).toEqual([
        expect.objectContaining({ name: 'write_file', args: { AbsolutePath: '/tmp/second.txt', content: 'second' } }),
      ]);
    });
  });

  it('retries a transient failure once, without forwarding credentials or upstream error text to clients', async () => {
    let attempts = 0;
    const upstream = await serve((req, res) => {
      attempts++;
      if (attempts === 1) {
        res.writeHead(503);
        res.end('secret-test-token');
      } else success(res);
    });
    const url = await proxy([model(upstream, { maxRetries: 1 })]);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] });
    expect(attempts).toBe(2);
    expect(JSON.stringify(getProxyMetrics())).not.toContain('secret-test-token');
  });

  it('follows configured fallback order, skipping disabled models and duplicates', async () => {
    const calls: string[] = [];
    const upstream = await serve((req, res) => {
      calls.push(req.url!);
      if (req.url!.includes('/good')) success(res, 'fallback');
      else {
        res.writeHead(502);
        res.end();
      }
    });
    const disabled = model(`${upstream}/disabled`, { enabled: false });
    const backup = model(`${upstream}/good`);
    const primary = model(`${upstream}/bad`, { fallbackModels: ['missing', disabled.name, backup.name, backup.name] });
    const url = await proxy([primary, disabled, backup]);
    expect(await (await fetch(url)).text()).toContain('fallback');
    expect(calls).toEqual(['/bad/chat/completions', '/good/chat/completions']);
    expect(buildFallbackChain(primary, [primary, disabled, backup])).toEqual([primary, backup]);
  });

  it('does not attribute usage from a failed stream to the fallback provider', async () => {
    clearDiagnostics();
    const empty = await serve((_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      sse(res, {
        type: 'message_start',
        message: { usage: { input_tokens: 100, cache_read_input_tokens: 60, output_tokens: 1 } },
      });
      sse(res, { type: 'message_stop' });
      res.end();
    });
    const ready = await serve((_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      sse(res, {
        choices: [{ delta: { content: 'fallback reply' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 2 },
      });
      res.end();
    });
    const backup = model(ready);
    const primary = model(empty, { provider: 'anthropic', fallbackModels: [backup.name] });
    expect(await (await fetch(await proxy([primary, backup], true))).text()).toContain('fallback reply');
    const record = getDiagnostics().requests[0];
    expect(record).toMatchObject({
      model: backup.name,
      provider: 'openai',
      outcome: 'succeeded',
      inputTokens: 12,
      outputTokens: 2,
    });
    expect(record).not.toHaveProperty('cachedTokens');
  });

  it('does not retry invalid caller requests or run a fallback for HTTP 400', async () => {
    let attempts = 0;
    const upstream = await serve((_req, res) => {
      attempts++;
      res.writeHead(400);
      res.end();
    });
    const backup = model(upstream);
    const url = await proxy([model(upstream, { maxRetries: 3, fallbackModels: [backup.name] }), backup]);
    expect((await fetch(url)).status).toBe(400);
    expect(attempts).toBe(1);
  });

  it('opens the primary circuit and skips it on the next request', async () => {
    let primaryCalls = 0;
    const upstream = await serve((req, res) => {
      if (req.url!.includes('/bad')) {
        primaryCalls++;
        res.writeHead(503);
        res.end();
      } else success(res);
    });
    const backup = model(`${upstream}/good`);
    const primary = model(`${upstream}/bad`, {
      circuitBreaker: { failureThreshold: 1 },
      fallbackModels: [backup.name],
    });
    const url = await proxy([primary, backup]);
    expect((await fetch(url)).status).toBe(200);
    expect((await fetch(url)).status).toBe(200);
    expect(primaryCalls).toBe(1);
  });

  it('handles idle timeout and socket error through a single retry owner', async () => {
    let attempts = 0;
    const upstream = await serve((_req, res) => {
      attempts++;
      if (attempts > 1) success(res);
    });
    const url = await proxy([model(upstream, { idleTimeout: 25, timeout: 100, maxRetries: 1 })]);
    expect((await fetch(url)).status).toBe(200);
    expect(attempts).toBe(2);
  });

  it('never retries or switches models after partial client-visible stream output', async () => {
    let attempts = 0;
    const upstream = await serve((_req, res) => {
      attempts++;
      res.setHeader('Content-Type', 'text/event-stream');
      sse(res, { choices: [{ delta: { content: 'partial' } }] });
      setTimeout(() => res.destroy(), 20);
    });
    const backup = model(upstream);
    const url = await proxy([model(upstream, { maxRetries: 3, fallbackModels: [backup.name] }), backup], true);
    const response = await fetch(url);
    const text = await response.text();
    expect(text).toContain('partial');
    expect(text).toContain('event: error');
    expect(attempts).toBe(1);
  });

  it('never replays a partial tool delta even before a complete tool call reaches the client', async () => {
    let attempts = 0;
    const upstream = await serve((_req, res) => {
      attempts++;
      res.setHeader('Content-Type', 'text/event-stream');
      sse(res, {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'tool-1', function: { name: 'lookup', arguments: '{' } }] } },
        ],
      });
      sse(res, { error: { message: 'failed' } });
      res.end();
    });
    const backup = model(upstream);
    const url = await proxy([model(upstream, { maxRetries: 3, fallbackModels: [backup.name] }), backup], true);
    expect((await fetch(url)).status).toBe(502);
    expect(attempts).toBe(1);
  });

  it('falls back from a stream that ends empty before emitting headers', async () => {
    const upstream = await serve((req, res) => {
      if (req.url!.includes('/empty')) {
        res.setHeader('Content-Type', 'text/event-stream');
        sse(res, '[DONE]');
        res.end();
      } else success(res, 'recovered');
    });
    const backup = model(`${upstream}/good`);
    const url = await proxy([model(`${upstream}/empty`, { fallbackModels: [backup.name] }), backup], true);
    const response = await fetch(url);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toContain('recovered');
  });

  it('does not turn incomplete tool JSON into an empty executable tool call', async () => {
    let attempts = 0;
    const upstream = await serve((_req, res) => {
      attempts++;
      res.setHeader('Content-Type', 'text/event-stream');
      sse(res, {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'one', function: { name: 'lookup', arguments: '{"unfinished":' } }] },
          },
        ],
      });
      sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      res.end();
    });
    const backup = model(upstream);
    const url = await proxy([model(upstream, { maxRetries: 3, fallbackModels: [backup.name] }), backup], true);
    const response = await fetch(url);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('incomplete tool arguments');
    expect(attempts).toBe(1);
  });

  it('routes native Google JSON to the gateway alias and strips Cloud Code fields', async () => {
    let captured: any;
    const upstream = await serve(async (req, res) => {
      captured = { url: req.url, headers: req.headers, body: await body(req) };
      res.end(
        JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'native' }] }, finishReason: 'STOP' }],
        }),
      );
    });
    const url = await proxy([
      model(`${upstream}/v1beta/`, {
        provider: 'google',
        externalModelName: 'models/family/alias:high',
        maxOutputTokens: 500,
        thinkingBudget: 50,
      }),
    ]);
    expect(await (await fetch(url)).json()).toMatchObject({
      candidates: [{ content: { parts: [{ text: 'native' }] } }],
    });
    expect(captured.url).toBe('/v1beta/models/family%2Falias%3Ahigh:generateContent');
    expect(captured.headers['x-goog-api-key']).toBe('secret-test-token');
    expect(captured.body.stream).toBeUndefined();
    expect(captured.body.model).toBeUndefined();
    expect(captured.body.generationConfig).toMatchObject({
      maxOutputTokens: 500,
      thinkingConfig: { thinkingBudget: 50 },
    });
  });

  it('decodes split UTF-8 Google SSE and retains Cloud Code envelopes only when requested', async () => {
    const upstream = await serve((_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      const bytes = Buffer.from(
        `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'merhaba 🌍' }] }, finishReason: 'STOP' }] })}\r\n\r\n`,
      );
      const split = bytes.indexOf(Buffer.from('🌍')) + 2;
      res.write(bytes.subarray(0, split));
      setImmediate(() => res.end(bytes.subarray(split)));
    });
    const url = await proxy([model(`${upstream}/v1beta`, { provider: 'google' })], true, true);
    const text = await (await fetch(url)).text();
    expect(text).toContain('merhaba 🌍');
    expect(text).toContain('"response":{"candidates"');
  });

  it('preserves explicit gateway conversation identity across turns without sending it to ordinary Google endpoints', async () => {
    const identities: (string | string[] | undefined)[] = [];
    const upstream = await serve(async (req, res) => {
      identities.push(req.headers['x-antigravity-conversation-id']);
      const payload = await body(req);
      expect(payload.conversationId).toBeUndefined();
      expect(payload.sessionId).toBeUndefined();
      res.end(
        JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }),
      );
    });
    const gateway = model(`${upstream}/v1beta`, { provider: 'google', gateway: true });
    const ordinary = { ...gateway, gateway: false };
    const url = await serve(async (req, res) => {
      const payload = await body(req);
      const selected = req.url === '/ordinary' ? ordinary : gateway;
      void runCustomModelRequest(
        res,
        selected,
        { ...payload, contents: [{ role: 'user', parts: [{ text: 'next turn' }] }] },
        false,
        [selected],
        false,
      );
    });
    for (const metadata of [
      { conversationId: 'same conversation 🌍\r\nvalue' },
      { conversationId: 'same conversation 🌍\r\nvalue' },
      { sessionId: 'different conversation' },
      {},
    ]) {
      expect((await fetch(url, { method: 'POST', body: JSON.stringify(metadata) })).status).toBe(200);
    }
    expect(
      (await fetch(`${url}/ordinary`, { method: 'POST', body: JSON.stringify({ conversationId: 'regular' }) })).status,
    ).toBe(200);
    expect(identities[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(identities[1]).toBe(identities[0]);
    expect(identities[2]).not.toBe(identities[0]);
    expect(identities[3]).toBeUndefined();
    expect(identities[4]).toBeUndefined();
  });

  it('isolates simultaneous Anthropic tool streams even when upstream reuses message IDs', async () => {
    const upstream = await serve(async (req, res) => {
      const input = await body(req);
      const token = input.messages[0].content;
      res.setHeader('Content-Type', 'text/event-stream');
      sse(res, { type: 'message_start', message: { id: 'same' } });
      sse(res, {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: `id-${token}`, name: 'lookup', input: {} },
      });
      setTimeout(() => {
        sse(res, {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify({ token }) },
        });
        sse(res, { type: 'content_block_stop', index: 0 });
        sse(res, { type: 'message_delta', delta: { stop_reason: 'tool_use' } });
        sse(res, { type: 'message_stop' });
        res.end();
      }, 15);
    });
    const url = await proxy([model(upstream, { provider: 'anthropic' })], true);
    const [first, second] = await Promise.all(
      ['/first', '/second'].map(async (suffix) => (await fetch(url + suffix)).text()),
    );
    expect(first).toContain('/first');
    expect(first).not.toContain('/second');
    expect(second).toContain('/second');
    expect(second).not.toContain('/first');
  });

  it('cancels upstream work when the client disconnects', async () => {
    let closed = false;
    const upstream = await serve((_req, res) => {
      res.on('close', () => {
        closed = true;
      });
      res.setHeader('Content-Type', 'text/event-stream');
      sse(res, { choices: [{ delta: { content: 'begin' } }] });
    });
    const url = await proxy([model(upstream)], true);
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    await response.body!.getReader().read();
    controller.abort();
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(getProxyMetrics().active).toBe(0);
  });

  it.each([429, 503])(
    'switches Google Cloud Code accounts after HTTP %s before output, wrapping and unwrapping the response',
    async (status) => {
      const captured: any[] = [];
      const upstream = await serve(async (req, res) => {
        captured.push({ url: req.url, auth: req.headers.authorization, body: await body(req) });
        if (req.headers.authorization === 'Bearer limited') {
          res.writeHead(status);
          res.end('{}');
        } else
          res.end(
            JSON.stringify({
              response: {
                candidates: [{ content: { role: 'model', parts: [{ text: 'pooled' }] }, finishReason: 'STOP' }],
              },
              traceId: 'upstream',
            }),
          );
      });
      const accounts = [
        { id: 'limited', accessToken: 'limited' },
        { id: 'ready', accessToken: 'ready', project: 'second-project' },
      ];
      const url = await proxy([
        model(upstream, {
          provider: 'google-cloudcode',
          apiKey: '',
          googleAccounts: accounts,
          googleProject: 'first-project',
        }),
      ]);
      expect(await (await fetch(url)).json()).toMatchObject({
        candidates: [{ content: { parts: [{ text: 'pooled' }] } }],
      });
      expect(captured.map((request) => request.auth)).toEqual(['Bearer limited', 'Bearer ready']);
      expect(captured[0].url).toBe('/v1internal:generateContent');
      expect(captured[0].body).toMatchObject({
        model: 'test-model',
        project: 'first-project',
        request: { contents: expect.any(Array) },
      });
      expect(captured[1].body.project).toBe('second-project');
      expect(getGooglePoolStatus().every((state) => state.inFlight === 0)).toBe(true);
    },
  );

  it.each([
    [401, /Reconnect this account/],
    [403, /account\/project permissions and service eligibility/],
    [429, /rate or quota limit/],
    [503, /temporarily unavailable/],
  ] as const)(
    'explains Google Cloud Code HTTP %s without exposing the provider error body',
    async (status, guidance) => {
      let calls = 0;
      const upstream = await serve((_req, res) => {
        calls++;
        res.writeHead(status);
        res.end(JSON.stringify({ error: { message: 'private-access-token private-project private-prompt' } }));
      });
      const url = await proxy([
        model(upstream, {
          provider: 'google-cloudcode',
          googleAccounts: [{ id: 'one-account', accessToken: 'owned-token' }],
        }),
      ]);
      const response = await fetch(url);
      expect(response.status).toBe(status);
      const result = await response.json();
      expect(result.error.message).toMatch(guidance);
      expect(result.error.message).toContain(`HTTP ${status}`);
      expect(JSON.stringify(result)).not.toMatch(/private-access-token|private-project|private-prompt|owned-token/);
      expect(calls).toBe(1);
    },
  );

  it('marks forbidden Google credentials and tries the next eligible account', async () => {
    const captured: string[] = [];
    const upstream = await serve((req, res) => {
      captured.push(req.headers.authorization!);
      if (req.headers.authorization === 'Bearer forbidden') {
        res.writeHead(403);
        res.end('{}');
      } else
        res.end(
          JSON.stringify({ response: { candidates: [{ content: { role: 'model', parts: [{ text: 'allowed' }] } }] } }),
        );
    });
    const url = await proxy([
      model(upstream, {
        provider: 'google-cloudcode',
        googleAccounts: [
          { id: 'forbidden', accessToken: 'forbidden' },
          { id: 'allowed', accessToken: 'allowed' },
        ],
      }),
    ]);
    expect((await fetch(url)).status).toBe(200);
    expect(captured).toEqual(['Bearer forbidden', 'Bearer allowed']);
    expect(getGooglePoolStatus()).toContainEqual(expect.objectContaining({ id: 'forbidden', status: 'forbidden' }));
  });

  it('keeps structured HTTP 403 quota exhaustion scoped to its model instead of forbidding the account', async () => {
    const captured: string[] = [];
    const upstream = await serve(async (req, res) => {
      const payload = await body(req);
      captured.push(`${req.headers.authorization}:${payload.model}`);
      if (req.headers.authorization === 'Bearer limited' && payload.model === 'gemini-pro') {
        res.writeHead(403);
        res.end(
          JSON.stringify({
            error: {
              status: 'RESOURCE_EXHAUSTED',
              message: 'private-prompt',
              details: [
                { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'DAILY_LIMIT_EXCEEDED' },
                { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2s' },
              ],
            },
          }),
        );
      } else
        res.end(
          JSON.stringify({ response: { candidates: [{ content: { role: 'model', parts: [{ text: 'allowed' }] } }] } }),
        );
    });
    const limited = { id: 'limited', accessToken: 'limited' };
    const url = await proxy([
      model(upstream, {
        provider: 'google-cloudcode',
        externalModelName: 'gemini-pro',
        googleAccounts: [limited, { id: 'available', accessToken: 'available' }],
      }),
    ]);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('private-prompt');
    expect(captured).toEqual(['Bearer limited:gemini-pro', 'Bearer available:gemini-pro']);
    expect(getGooglePoolStatus()).toContainEqual(
      expect.objectContaining({
        id: 'limited',
        lastStatus: 403,
        modelCooldowns: [expect.objectContaining({ modelName: 'gemini-pro', reason: 'quota-exhausted' })],
      }),
    );
    expect(getGooglePoolStatus().find((state) => state.id === 'limited')?.status).not.toBe('forbidden');
    const otherModel = await proxy([
      model(upstream, {
        provider: 'google-cloudcode',
        externalModelName: 'gemini-flash',
        googleAccounts: [limited],
      }),
    ]);
    const otherResponse = await fetch(otherModel);
    expect(otherResponse.status).toBe(200);
    await otherResponse.text();
    expect(captured.at(-1)).toBe('Bearer limited:gemini-flash');
  });

  it('uses structured Google retry hints, records measured account health and never exposes upstream secrets', async () => {
    const started = Date.now();
    const upstream = await serve((req, res) => {
      if (req.headers.authorization === 'Bearer short-burst') {
        res.writeHead(429);
        res.end(
          JSON.stringify({
            error: {
              message: 'sensitive echoed prompt and credential',
              details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2s' }],
            },
          }),
        );
      } else
        res.end(
          JSON.stringify({ response: { candidates: [{ content: { role: 'model', parts: [{ text: 'healthy' }] } }] } }),
        );
    });
    const url = await proxy([
      model(upstream, {
        provider: 'google-cloudcode',
        googlePool: { cooldownMs: 60_000 },
        googleAccounts: [
          { id: 'short-burst', accessToken: 'short-burst' },
          { id: 'healthy', accessToken: 'healthy' },
        ],
      }),
    ]);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('sensitive');
    const limited = getGooglePoolStatus().find((state) => state.id === 'short-burst')!;
    expect(limited.cooldownUntil).toBeGreaterThanOrEqual(started + 2000);
    expect(limited.cooldownUntil).toBeLessThanOrEqual(Date.now() + 2000);
    expect(limited).toMatchObject({
      requests: 1,
      failed: 1,
      lastStatus: 429,
      modelCooldowns: [expect.objectContaining({ reason: 'rate-limited' })],
    });
    expect(getGooglePoolStatus()).toContainEqual(
      expect.objectContaining({ id: 'healthy', succeeded: 1, failed: 0, avgLatencyMs: expect.any(Number) }),
    );
    expect(JSON.stringify(getGooglePoolStatus())).not.toContain('sensitive');
  });

  it('does not bypass an upstream account cooldown by switching to a local effort alias', async () => {
    const requested: string[] = [];
    const upstream = await serve(async (req, res) => {
      const payload = await body(req);
      requested.push(payload.model);
      if (payload.model === 'gemini-pro') {
        res.writeHead(429);
        res.end('{}');
      } else
        res.end(
          JSON.stringify({
            response: { candidates: [{ content: { role: 'model', parts: [{ text: 'flash reply' }] } }] },
          }),
        );
    });
    const account = { id: 'effort-alias-account', accessToken: 'fixture' };
    const high = model(upstream, {
      provider: 'google-cloudcode',
      externalModelName: 'gemini-pro',
      googleAccounts: [account],
    });
    const flash = model(upstream, {
      provider: 'google-cloudcode',
      externalModelName: 'gemini-flash',
      googleAccounts: [account],
    });
    const low = model(upstream, {
      provider: 'google-cloudcode',
      externalModelName: 'gemini-pro',
      googleAccounts: [account],
      fallbackModels: [high.name, flash.name],
    });
    expect(await (await fetch(await proxy([low, high, flash]))).text()).toContain('flash reply');
    expect(requested).toEqual(['gemini-pro', 'gemini-flash']);
  });

  it('does not rotate Google accounts for an explicit generation test', async () => {
    let calls = 0;
    const upstream = await serve((_req, res) => {
      calls++;
      res.writeHead(429);
      res.end('{}');
    });
    const candidate = model(upstream, {
      provider: 'google-cloudcode',
      googleAccounts: [
        { id: 'first-test', accessToken: 'first-test' },
        { id: 'second-test', accessToken: 'second-test' },
      ],
    });
    const url = await serve((_req, res) => {
      void runCustomModelRequest(
        res,
        candidate,
        { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] },
        false,
        [candidate],
        false,
        'generation-test',
      );
    });
    expect((await fetch(url)).status).toBe(429);
    expect(calls).toBe(1);
  });

  it('keeps one Google account for the entire stream and never switches after a partial response', async () => {
    const captured: string[] = [];
    const upstream = await serve((req, res) => {
      captured.push(req.headers.authorization!);
      expect(req.url).toBe('/v1internal:streamGenerateContent?alt=sse');
      res.setHeader('Content-Type', 'text/event-stream');
      sse(res, { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'account-one' }] } }] } });
      sse(res, { error: { message: 'interrupted' } });
      res.end();
    });
    const url = await proxy(
      [
        model(upstream, {
          provider: 'google-cloudcode',
          maxRetries: 3,
          googleAccounts: [
            { id: 'one', accessToken: 'one' },
            { id: 'two', accessToken: 'two' },
          ],
        }),
      ],
      true,
    );
    const text = await (await fetch(url)).text();
    expect(text).toContain('account-one');
    expect(text).toContain('event: error');
    expect(captured).toEqual(['Bearer one']);
  });
});

describe('provider and configuration contracts', () => {
  it('accepts the adaptive Google pool strategy and rejects misspelled strategies', () => {
    const config = model('https://daily-cloudcode-pa.googleapis.com', {
      provider: 'google-cloudcode',
      googlePool: { strategy: 'adaptive' },
    });
    expect(validateCustomModel(config).valid).toBe(true);
    expect(validateCustomModel({ ...config, googlePool: { strategy: 'adpative' } }).valid).toBe(false);
  });
  it('rejects embedded URL credentials before saving or routing a model', () => {
    expect(validateCustomModel(model('https://user:secret@example.com/v1')).valid).toBe(false);
    expect(validateCustomModel(model('https://user@example.com/v1')).valid).toBe(false);
    expect(validateCustomModel(model('https://example.com/v1')).valid).toBe(true);
  });
  it('pairs repeated historical tool calls and results without relying on another request state', () => {
    const request = {
      contents: [
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'lookup', args: { key: 'a' } } },
            { functionCall: { name: 'lookup', args: { key: 'b' } } },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'lookup', response: 'a' } },
            { functionResponse: { name: 'lookup', response: 'b' } },
          ],
        },
      ],
    };
    const openai = translateRequest('openai', request, 'test', 'openai', 'isolated') as any;
    expect(openai.messages[1].tool_call_id).toBe(openai.messages[0].tool_calls[0].id);
    expect(openai.messages[2].tool_call_id).toBe(openai.messages[0].tool_calls[1].id);
    const anthropic = translateRequest('anthropic', request, 'test', 'anthropic', 'isolated') as any;
    expect(anthropic.messages[1].content[0].tool_use_id).toBe(anthropic.messages[0].content[0].id);
    expect(anthropic.messages[1].content[1].tool_use_id).toBe(anthropic.messages[0].content[1].id);
    expect(
      getProviderUrl('http://localhost/v1/chat/completions', 'test', false, getTranslator('custom', 'anthropic')),
    ).toBe('http://localhost/v1/messages');
  });
  it('preserves old wire formats while new presets select the advertised format explicitly', () => {
    for (const provider of ['deepseek', 'kimi', 'fireworks', 'lmstudio', 'llamacpp']) {
      expect(resolveApiFormat(provider)).toBe('anthropic');
      expect(getProvider(provider)!.apiFormat).toBe('openai');
      expect(resolveApiFormat(provider, 'openai')).toBe('openai');
    }
    for (const preset of PROVIDERS)
      expect(
        validateCustomModel(
          model((preset.defaultUrl || 'http://localhost:8000').replace('ACCOUNT_ID', 'a'.repeat(32)), {
            provider: preset.id,
            apiFormat: preset.apiFormat,
          }),
        ).valid,
      ).toBe(true);
    expect(getProviderHeaders('anthropic', '')['anthropic-version']).toBe('2023-06-01');
    expect(getProviderHeaders('openrouter', 'key').Authorization).toBe('Bearer key');
    expect(() => getProviderHeaders('openai', 'DECRYPTION_FAILED_STORAGE_UNAVAILABLE')).toThrow(/decrypt/);
  });

  it('normalizes paths and switches native Gemini methods without double slash or duplicate model segments', () => {
    for (const base of [
      'http://localhost:51000/v1beta',
      'http://localhost:51000/v1beta/',
      'http://localhost:51000/v1beta/models/',
      'http://localhost:51000/v1beta/models/old:generateContent?key=test',
    ]) {
      const url = new URL(getGoogleApiUrl(base, 'models/new/name', true));
      expect(url.pathname).toBe('/v1beta/models/new%2Fname:streamGenerateContent');
      expect(url.searchParams.get('alt')).toBe('sse');
    }
    expect(getGoogleApiUrl('http://localhost/v1beta/models/old:streamGenerateContent?alt=sse', 'new', false)).toBe(
      'http://localhost/v1beta/models/new:generateContent',
    );
    expect(getProviderUrl('http://localhost/v1?key=test', 'model', false, getTranslator('openai'))).toBe(
      'http://localhost/v1/chat/completions?key=test',
    );
  });

  it('maps reasoning and thinking controls into the selected protocol and protects conversation fields', () => {
    const base = model('http://localhost', { maxOutputTokens: 8192, reasoningEffort: 'high', thinkingBudget: 2048 });
    expect(applyRequestOptions({ max_completion_tokens: 4000 }, base, 'openai', true)).toMatchObject({
      max_completion_tokens: 8192,
      reasoning_effort: 'high',
      stream: true,
    });
    expect(applyRequestOptions({ max_tokens: 4000, temperature: 0.5 }, base, 'anthropic', false)).toEqual({
      max_tokens: 8192,
      stream: false,
      thinking: { type: 'enabled', budget_tokens: 2048 },
    });
    expect(() => applyRequestOptions({}, { ...base, extraBody: { messages: [] } }, 'openai', false)).toThrow(
      /cannot override/,
    );
    expect(validateCustomModel({ ...base, customHeaders: { 'Content-Length': '123' } }).valid).toBe(false);
    expect(validateCustomModel({ ...base, fallbackModels: [1] }).valid).toBe(false);
    expect(validateCustomModel({ ...base, supportsThinking: false }).valid).toBe(true);
    expect(validateCustomModel({ ...base, supportsThinking: true }).valid).toBe(true);
    expect(validateCustomModel({ ...base, supportsThinking: 'false' }).valid).toBe(false);
  });

  it('trims complete turns including tool call/result pairs and preserves system and tool schemas', () => {
    const request = {
      systemInstruction: { parts: [{ text: 'keep' }] },
      tools: [{ functionDeclarations: [] }],
      contents: [
        { role: 'user', parts: [{ text: 'old'.repeat(400) }] },
        { role: 'model', parts: [{ functionCall: { name: 'lookup', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'lookup', response: {} } }] },
        { role: 'model', parts: [{ text: 'done' }] },
        { role: 'user', parts: [{ text: 'latest' }] },
      ],
    };
    const result = trimContext(request, 250, 20);
    expect(result.contents).toEqual([request.contents[4]]);
    expect(result.systemInstruction).toEqual(request.systemInstruction);
    expect(result.tools).toEqual(request.tools);
    expect(request.contents).toHaveLength(5);
    expect(() => trimContext(request, 10, 5)).toThrow(/latest turn/);
  });

  it('allows only one circuit probe after cooldown and honors numeric or HTTP-date Retry-After', () => {
    let now = 100;
    const circuit = new CircuitBreaker(() => now);
    circuit.fail('a', { failureThreshold: 1 });
    expect(circuit.acquire('a', { cooldownMs: 50 })).toBe(false);
    now += 51;
    expect(circuit.acquire('a', { cooldownMs: 50 })).toBe(true);
    expect(circuit.acquire('a', { cooldownMs: 50 })).toBe(false);
    circuit.succeed('a');
    expect(circuit.acquire('a')).toBe(true);
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(new Date(5000).toUTCString(), 1000)).toBe(4000);
    expect(parseRetryAfter('999999')).toBe(30000);
  });
});
