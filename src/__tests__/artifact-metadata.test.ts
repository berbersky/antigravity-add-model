import { describe, expect, it } from 'vitest';
import {
  collectArtifactContext,
  normalizeArtifactCandidate,
  normalizeArtifactResponse,
} from '../proxy/artifactMetadata';
import { collectToolSchemas } from '../proxy/translators/utils';

const header = (count = 1) =>
  `The user has ${count} active workspaces, each defined by a URI and a CorpusName. Multiple URIs potentially map to the same CorpusName. The mapping is shown as follows in the format [URI] -> [CorpusName]:`;
const schema = (name = 'write_to_file') => {
  const payload =
    name === 'write_to_file'
      ? { CodeContent: { type: 'STRING' } }
      : name === 'replace_file_content'
        ? { TargetContent: { type: 'STRING' }, ReplacementContent: { type: 'STRING' } }
        : { ReplacementChunks: { type: 'ARRAY' } };
  return {
    type: 'OBJECT',
    properties: {
      TargetFile: { type: 'STRING' },
      ...payload,
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
    required: ['TargetFile', ...Object.keys(payload)],
  };
};
const system = (workspace = '/repo', artifact = '/home/user/brain/current') =>
  `${header()}\n${workspace} -> owner/repo\n\n<artifacts>\nAll artifacts should be written to the artifact directory: \`<appDataDir>/brain/<conversation-id>\`.\nArtifact Directory Path: ${artifact}\n</artifacts>`;
const body = (text = system(), name = 'write_to_file') => ({
  systemInstruction: { parts: [{ text }] },
  tools: [{ functionDeclarations: [{ name, parameters: schema(name) }] }],
});
const context = (text = system(), name = 'write_to_file') => {
  const request = body(text, name);
  return collectArtifactContext(request, collectToolSchemas(request));
};
const metadata = { Summary: 'File summary', UserFacing: false, RequestFeedback: false };
const candidate = (TargetFile = '/repo/result.txt', name = 'write_to_file') => ({
  index: 0,
  finishReason: 'STOP',
  content: {
    role: 'model',
    parts: [
      { text: 'opaque thought', thought: true },
      {
        functionCall: {
          id: 'call-original',
          name,
          args: { TargetFile, CodeContent: 'unchanged', Overwrite: false, ArtifactMetadata: { ...metadata } },
        },
      },
    ],
  },
});

describe('native workspace ArtifactMetadata correction', () => {
  it('removes only optional artifact metadata without mutating args, IDs, thoughts, or flags', () => {
    const original = candidate(),
      snapshot = structuredClone(original);
    const result = normalizeArtifactCandidate(original, context()) as typeof original;
    expect(result).not.toBe(original);
    expect(result.content.parts[0]).toBe(original.content.parts[0]);
    expect(result.content.parts[1].functionCall).toEqual({
      id: 'call-original',
      name: 'write_to_file',
      args: { TargetFile: '/repo/result.txt', CodeContent: 'unchanged', Overwrite: false },
    });
    expect(original).toEqual(snapshot);
  });

  it.each(['write_to_file', 'replace_file_content', 'multi_replace_file_content'])(
    'recognizes the declared native %s tool',
    (name) => {
      const original = candidate('/repo/file.txt', name);
      expect(normalizeArtifactCandidate(original, context(system(), name))).not.toBe(original);
    },
  );

  it('handles Windows separators and case independently of the proxy host', () => {
    const original = candidate('C:/WORKSPACE/src/result.txt');
    expect(
      normalizeArtifactCandidate(original, context(system('c:\\workspace', 'C:\\Users\\user\\brain\\current'))),
    ).not.toBe(original);
  });

  it('accepts declared file URI workspaces and multiple roots', () => {
    const text = system().replace(
      `${header()}\n/repo -> owner/repo`,
      `${header(2)}\nfile:///repo%20one -> owner/one\n\nfile:///repo-two -> owner/two`,
    );
    const ctx = context(text);
    expect(ctx).toBeDefined();
    for (const target of ['/repo one/file.txt', '/repo-two/file.txt']) {
      const original = candidate(target);
      expect(normalizeArtifactCandidate(original, ctx)).not.toBe(original);
    }
  });

  it('supports Windows file URIs and UNC workspaces', () => {
    for (const [workspace, artifact, target] of [
      ['file:///C:/workspace', 'C:\\brain\\current', 'c:\\workspace\\file.txt'],
      ['file://server/share/workspace', '\\\\server\\share\\brain', '\\\\SERVER\\share\\workspace\\file.txt'],
    ]) {
      const original = candidate(target);
      expect(normalizeArtifactCandidate(original, context(system(workspace, artifact)))).not.toBe(original);
    }
  });

  it.each([
    '/home/user/brain/current/plan.md',
    '/outside/file.txt',
    '/repo-other/file.txt',
    '/repo',
    'relative.txt',
    '/repo/../outside/file.txt',
    '/repo/./file.txt',
    '/repo/folder/',
    '//repo/file.txt',
    'file:///repo/file.txt',
  ])('preserves artifact, outside, or ambiguous target %s', (target) => {
    const original = candidate(target);
    expect(normalizeArtifactCandidate(original, context())).toBe(original);
  });

  it.each([
    'C:workspace\\file.txt',
    '\\workspace\\file.txt',
    'C:\\workspace-other\\file.txt',
    'C:\\workspace\\..\\elsewhere\\file.txt',
    'C:\\workspace\\file.txt.',
    'C:\\workspace\\file.txt ',
    'C:\\workspace\\file:stream',
    '\\\\?\\C:\\workspace\\file.txt',
    'C:\\workspace\\file\u0000.txt',
  ])('preserves ambiguous Windows target %s', (target) => {
    const original = candidate(target);
    expect(normalizeArtifactCandidate(original, context(system('C:\\workspace', 'C:\\brain\\current')))).toBe(original);
  });

  it('preserves artifacts even when their directory is inside a workspace', () => {
    const original = candidate('/repo/brain/current/plan.md');
    expect(normalizeArtifactCandidate(original, context(system('/repo', '/repo/brain/current')))).toBe(original);
  });

  it('keeps POSIX case distinctions', () => {
    const original = candidate('/REPO/file.txt');
    expect(normalizeArtifactCandidate(original, context())).toBe(original);
  });

  it('normalizes all response candidates while preserving unrelated fields and objects', () => {
    const original = {
      candidates: [candidate(), candidate('/home/user/brain/current/plan.md')],
      usageMetadata: { totalTokenCount: 25 },
    };
    const result = normalizeArtifactResponse(original, context()) as typeof original;
    expect(result.candidates[0]).not.toBe(original.candidates[0]);
    expect(result.candidates[1]).toBe(original.candidates[1]);
    expect(result.usageMetadata).toBe(original.usageMetadata);
  });

  it('leaves unsupported tools, metadata, and malformed envelopes untouched', () => {
    const ctx = context();
    for (const value of [
      null,
      [],
      {},
      { content: { parts: [null, { functionCall: null }] } },
      candidate('/repo/file.txt', 'custom_write'),
    ])
      expect(normalizeArtifactCandidate(value, ctx)).toBe(value);
    for (const value of [null, [], {}, { candidates: 'bad' }])
      expect(normalizeArtifactResponse(value, ctx)).toBe(value);
    for (const value of [null, [], 'artifact', { ...metadata, custom: true }, { Summary: 'missing flags' }]) {
      const original = candidate();
      (original.content.parts[1].functionCall!.args as Record<string, unknown>).ArtifactMetadata = value;
      expect(normalizeArtifactCandidate(original, ctx)).toBe(original);
    }
    const original = candidate();
    expect(normalizeArtifactCandidate(original)).toBe(original);
  });
});

describe('request-scoped native artifact context', () => {
  it('reads only system context and accepts normalized JSON-schema types', () => {
    const request = body();
    const schemas = collectToolSchemas(request);
    expect(collectArtifactContext(request, schemas)).toBeDefined();
    const lowercase = JSON.parse(
      JSON.stringify(request)
        .replace(/OBJECT/g, 'object')
        .replace(/STRING/g, 'string')
        .replace(/BOOLEAN/g, 'boolean'),
    );
    expect(collectArtifactContext(lowercase, collectToolSchemas(lowercase))).toBeDefined();
    expect(
      collectArtifactContext({ contents: [{ role: 'user', parts: [{ text: system() }] }] }, schemas),
    ).toBeUndefined();
    expect(collectArtifactContext(body('no context'), schemas)).toBeUndefined();
  });

  it.each([
    system().replace(
      'Artifact Directory Path: /home/user/brain/current',
      'Artifact Directory Path: <appDataDir>/brain/<id>',
    ),
    system().replace('Artifact Directory Path: /home/user/brain/current', 'Artifact Directory Path: relative/path'),
    system() + '\n<artifacts>\nArtifact Directory Path: /other\n</artifacts>',
    system().replace('</artifacts>', 'Artifact Directory Path: /other\n</artifacts>'),
    system().replace('<artifacts>', ''),
    system().replace('</artifacts>', ''),
    system().replace(header(), header(2)),
    system() + `\n${header()}\n/other -> other`,
    system('relative/path'),
    system('/repo/../other'),
    system('file:///repo/../other'),
    system('file:///repo/%2e%2e/other'),
    system('file:///repo%2fother'),
    system('file:///repo?query=true'),
    system('https://example.com/repo'),
    system('C:\\repo', '/home/brain'),
  ])('disables correction for incomplete or ambiguous context', (text) => {
    expect(context(text)).toBeUndefined();
  });

  it('does not reuse another request or accept duplicate tool declarations', () => {
    const request = body();
    request.tools[0].functionDeclarations.push(request.tools[0].functionDeclarations[0]);
    expect(collectArtifactContext(request, collectToolSchemas(request))).toBeUndefined();
    expect(context()).toBeDefined();
    expect(context(system().replace('Artifact Directory Path:', 'Unknown Directory Path:'))).toBeUndefined();
  });

  it('requires native optional metadata and the expected file-tool schema', () => {
    const base = schema();
    const variants: unknown[] = [
      undefined,
      null,
      {},
      { $ref: '#/$defs/native' },
      { ...base, required: [...base.required, 'ArtifactMetadata'] },
      { ...base, allOf: [{ required: ['ArtifactMetadata'] }] },
      { ...base, dependencies: { CodeContent: ['ArtifactMetadata'] } },
      { ...base, not: { not: { required: ['ArtifactMetadata'] } } },
      { ...base, required: [] },
      { ...base, properties: { ...base.properties, TargetFile: { type: 'NUMBER' } } },
      {
        ...base,
        properties: {
          ...base.properties,
          ArtifactMetadata: { ...base.properties.ArtifactMetadata, description: 'Custom metadata' },
        },
      },
      { ...base, properties: { TargetFile: { type: 'STRING' } } },
    ];
    for (const value of variants)
      expect(collectArtifactContext(body(), new Map([['write_to_file', value]]))).toBeUndefined();
    expect(collectArtifactContext(body(), new Map([['custom_write', base]]))).toBeUndefined();
  });
});
