import type { ModelProtocol } from '../../../../../shared/types.js';
import { modelUsage, preflightModel, type ModelRuntimeOptions, type ModelUsage } from '../../../../../shared/model-runtime.js';

export interface TransportSettings extends ModelRuntimeOptions {
  baseUrl: string; model: string; apiKey: string; hasKey: boolean; mode: 'demo' | 'live'; protocol?: ModelProtocol; enabled?: boolean;
}
export interface TransportImage { mime: string; data: string }
export interface TransportRequest { url: string; headers: Record<string, string>; body: Record<string, unknown> }
export interface TransportDependencies {
  buildRequest: (settings: TransportSettings, context: string, images: TransportImage[]) => TransportRequest;
  parseResponse: (protocol: ModelProtocol, data: unknown) => string;
  assertUrl: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  onText?: (delta: string) => void;
  onUsage?: (usage: ModelUsage) => void;
  maxResponseBytes?: number;
}
export class ModelTransportError extends Error {
  constructor(message: string, public code: string, public status = 502, public retryable = true) { super(message); }
}
type RecordValue = Record<string, any>;
const record = (v: unknown): RecordValue => v && typeof v === 'object' ? v as RecordValue : {};
const tokenCount = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
/** One bounded request, including the stream reader, uses the same timeout and cancellation signal. */
export async function generateModelTransport(settings: TransportSettings, context: string, images: TransportImage[], signal: AbortSignal, deps: TransportDependencies): Promise<{ text: string; usage: ModelUsage }> {
  let preflight: ReturnType<typeof preflightModel>;
  try { preflight = preflightModel(settings, context, images.length); }
  catch (error) { throw new ModelTransportError(error instanceof Error ? error.message : '模型能力预检失败。', 'MODEL_CAPABILITY_REJECTED', 400, false); }
  if (!settings.apiKey) throw new ModelTransportError('请先配置模型 API Key。', 'MODEL_UNAVAILABLE', 400, false);
  const protocol = settings.protocol || 'chat-completions';
  const { options } = preflight;
  const timed = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]);
  await deps.assertUrl(settings.baseUrl);
  timed.throwIfAborted();
  const request = deps.buildRequest(settings, context, images);
  request.body.stream = true;
  if (protocol === 'responses') request.body.max_output_tokens = options.maxOutputTokens;
  else request.body.max_tokens = options.maxOutputTokens;
  if (protocol === 'chat-completions') request.body.stream_options = { include_usage: true };
  // Preserve older Responses/Anthropic requests that did not send temperature.
  if (protocol === 'chat-completions' || settings.temperature !== undefined) request.body.temperature = options.temperature;
  let response: Response;
  try { response = await (deps.fetch || fetch)(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: timed, redirect: 'error' }); }
  catch { if (timed.aborted) throw timed.reason; throw new ModelTransportError('模型服务连接失败。', 'PROVIDER_CONNECTION_ERROR'); }
  if (!response.ok) {
    await response.body?.cancel();
    const timeout = response.status === 504 || response.status === 524;
    throw new ModelTransportError(`模型服务请求失败（HTTP ${response.status}）。`, timeout ? 'UPSTREAM_TIMEOUT' : 'PROVIDER_HTTP_ERROR', timeout ? 504 : 502);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ModelTransportError('模型服务未返回响应正文。', 'EMPTY_OUTPUT');
  const maxBytes = deps.maxResponseBytes ?? 8 * 1024 * 1024;
  let bytes = 0, text = '', buffer = '', ended = false, anthropicStopped = false, input: number | undefined, output: number | undefined;
  const decoder = new TextDecoder();
  const addText = (v: unknown) => { if (typeof v === 'string') { text += v; deps.onText?.(v); } };
  const usageFrom = (v: unknown) => {
    const u = record(v);
    input = tokenCount(u.input_tokens ?? u.prompt_tokens) ?? input;
    output = tokenCount(u.output_tokens ?? u.completion_tokens) ?? output;
  };
  const consume = (block: string) => {
    const lines = block.split('\n');
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    if (data === '[DONE]') return;
    let value: RecordValue;
    try { value = record(JSON.parse(data)); } catch { throw new ModelTransportError('模型流包含无效 JSON。', 'PROVIDER_INVALID_RESPONSE'); }
    const type = value.type || event;
    if (value.error || type === 'error' || type === 'response.failed' || type === 'response.error') throw new ModelTransportError('模型服务报告生成失败。', 'PROVIDER_ERROR');
    if (protocol === 'chat-completions') {
      usageFrom(value.usage);
      const choice = record(value.choices?.[0]);
      if (choice.finish_reason && choice.finish_reason !== 'stop') throw new ModelTransportError('模型响应截断或拒绝生成。', 'PROVIDER_TRUNCATED');
      if (choice.finish_reason === 'stop') ended = true;
      const delta = record(choice.delta);
      if (delta.refusal) throw new ModelTransportError('模型拒绝生成。', 'PROVIDER_REFUSED');
      addText(delta.content);
    } else if (protocol === 'responses') {
      if (type === 'response.output_text.delta') addText(value.delta);
      if (type === 'response.refusal.delta' || type === 'response.incomplete') throw new ModelTransportError('模型响应不完整或拒绝生成。', 'PROVIDER_TRUNCATED');
      if (type === 'response.completed') {
        const result = record(value.response);
        const complete = deps.parseResponse(protocol, result);
        if (!text) addText(complete);
        usageFrom(result.usage); ended = true;
      }
    } else {
      if (type === 'message_start') usageFrom(record(value.message).usage);
      if (type === 'content_block_delta' && record(value.delta).type === 'text_delta') addText(record(value.delta).text);
      if (type === 'message_delta') {
        usageFrom(value.usage);
        const reason = record(value.delta).stop_reason;
        if (reason && reason !== 'end_turn' && reason !== 'stop_sequence') throw new ModelTransportError('模型响应截断或拒绝生成。', 'PROVIDER_TRUNCATED');
        if (reason === 'end_turn' || reason === 'stop_sequence') anthropicStopped = true;
      }
      if (type === 'message_stop') ended = anthropicStopped;
    }
  };
  const isStream = response.headers.get('content-type')?.toLowerCase().includes('text/event-stream');
  const abortRead = () => { void reader.cancel().catch(() => {}); };
  timed.addEventListener('abort', abortRead, { once: true });
  try {
    while (true) {
      timed.throwIfAborted();
      const chunk = await reader.read();
      timed.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new ModelTransportError('模型响应超过大小限制。', 'PROVIDER_RESPONSE_TOO_LARGE');
      buffer += decoder.decode(chunk.value, { stream: true });
      if (isStream) {
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) { consume(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
      }
    }
    buffer += decoder.decode();
    if (isStream) {
      if (buffer.trim()) consume(buffer.replace(/\r\n/g, '\n'));
      if (!ended) throw new ModelTransportError('模型流意外中断，未保存正文。', 'PROVIDER_TRUNCATED');
    } else {
      let data: unknown;
      try { data = JSON.parse(buffer); } catch { throw new ModelTransportError('模型返回无效 JSON。', 'PROVIDER_INVALID_RESPONSE'); }
      text = deps.parseResponse(protocol, data); usageFrom(record(data).usage);
      deps.onText?.(text);
    }
    if (!text.trim()) throw new ModelTransportError('模型未返回文本内容。', 'EMPTY_OUTPUT');
    const usage = modelUsage(input ?? preflight.estimatedInputTokens, output ?? Array.from(text).length, input === undefined || output === undefined, settings);
    deps.onUsage?.(usage);
    return { text, usage };
  } catch (error) {
    if (timed.aborted) throw timed.reason;
    if (error instanceof ModelTransportError) throw error;
    throw new ModelTransportError('模型响应读取失败。', 'PROVIDER_INVALID_RESPONSE');
  } finally {
    timed.removeEventListener('abort', abortRead);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
