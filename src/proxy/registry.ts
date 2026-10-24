/** Wire-format dispatch, independent from provider branding and authentication. */
import * as openai from './translators/openai';
import * as anthropic from './translators/anthropic';
import * as google from './translators/google';
import { ApiFormat, isOpencodeEndpoint, OPENCODE_USER_AGENT, resolveApiFormat } from '../providers';
import type { ToolSchemas } from './translators/utils';
import { normalizeArtifactCandidate, normalizeArtifactResponse, type ArtifactContext } from './artifactMetadata';

export interface TranslatorModule {
  [key: string]: unknown;
}
export interface ProviderHeaders {
  'Content-Type': string;
  [key: string]: string | undefined;
}

export function getTranslator(provider: string, apiFormat?: ApiFormat): TranslatorModule {
  const format = resolveApiFormat(provider, apiFormat);
  return format === 'google' ? google : format === 'anthropic' ? anthropic : openai;
}

export function translateRequest(
  provider: string,
  body: unknown,
  modelName: string,
  apiFormat?: ApiFormat,
  stateKey?: string,
): unknown {
  const format = resolveApiFormat(provider, apiFormat);
  if (format === 'google') return google.mapGeminiToGoogle(body as never, modelName);
  if (format === 'anthropic') return anthropic.mapGeminiToAnthropic(body as never, modelName, stateKey);
  return openai.mapGeminiToOpenAI(body as never, modelName, stateKey);
}

export function translateResponse(
  provider: string,
  response: unknown,
  stateKey: string,
  apiFormat?: ApiFormat,
  toolSchemas?: ToolSchemas,
  artifactContext?: ArtifactContext,
): unknown {
  const format = resolveApiFormat(provider, apiFormat);
  const mapped =
    format === 'google'
      ? google.mapGoogleToGemini(response, stateKey)
      : format === 'anthropic'
        ? anthropic.mapAnthropicToGemini(response as never, stateKey, toolSchemas)
        : openai.mapOpenAIToGemini(response as never, stateKey, toolSchemas);
  return normalizeArtifactResponse(mapped, artifactContext);
}

export function translateStreamChunk(
  provider: string,
  chunk: unknown,
  stateKey: string,
  apiFormat?: ApiFormat,
  streamKey?: string,
  toolSchemas?: ToolSchemas,
  artifactContext?: ArtifactContext,
): unknown {
  const format = resolveApiFormat(provider, apiFormat);
  const mapped =
    format === 'google'
      ? google.mapGoogleChunkToGemini(chunk, stateKey)
      : format === 'anthropic'
        ? anthropic.mapAnthropicChunkToGemini(chunk as never, stateKey, streamKey, toolSchemas)
        : openai.mapOpenAIChunkToGemini(chunk as never, stateKey, streamKey, toolSchemas);
  // Normalize before customRequest records reasoning against the emitted arguments.
  return normalizeArtifactCandidate(mapped, artifactContext);
}

export function getProviderHeaders(provider: string, apiKey = '', apiFormat?: ApiFormat, apiUrl = ''): ProviderHeaders {
  const headers: ProviderHeaders = { 'Content-Type': 'application/json' };
  const format = resolveApiFormat(provider, apiFormat);
  const opencode = isOpencodeEndpoint(apiUrl, provider);
  if (format === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  if (apiKey && apiKey !== 'none') {
    if (/^(enc:|fallback:|local-gcm:|DECRYPTION_FAILED)/.test(apiKey))
      throw new Error('API key could not be decrypted; save the key again.');
    if (opencode) headers.Authorization = `Bearer ${apiKey}`;
    else if (format === 'google') headers['x-goog-api-key'] = apiKey;
    else if (format === 'anthropic') headers['x-api-key'] = apiKey;
    else headers.Authorization = `Bearer ${apiKey}`;
  }
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://antigravity.google';
    headers['X-Title'] = 'Antigravity';
  }
  if (opencode) headers['User-Agent'] = OPENCODE_USER_AGENT;
  return headers;
}

export function supportsStreaming(_provider: string): boolean {
  return true;
}

export function getProviderUrl(
  baseUrl: string,
  modelName: string,
  isStream: boolean,
  translator: TranslatorModule | null,
): string {
  if (typeof translator?.getGoogleApiUrl === 'function')
    return translator.getGoogleApiUrl(baseUrl, modelName, isStream);
  const url = new URL(baseUrl);
  let pathname = url.pathname.replace(/\/+$/, '');
  const anthropicFormat = translator === anthropic;
  pathname = pathname.replace(/\/(?:chat\/completions|completions|messages)$/, '');
  if (!pathname) pathname = '/v1';
  pathname += anthropicFormat ? '/messages' : '/chat/completions';
  url.pathname = pathname;
  return url.toString();
}
