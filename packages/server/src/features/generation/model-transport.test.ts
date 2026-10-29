import test from 'node:test';
import assert from 'node:assert/strict';
import { generateModelTransport, ModelTransportError, type TransportDependencies, type TransportSettings } from './model-transport.js';
const settings: TransportSettings = { baseUrl: 'https://example.com', model: 'test', apiKey: 'secret-token', mode: 'live', hasKey: true };
function deps(protocol: string, chunks: string[], capture?: (body: any) => void): TransportDependencies {
  return {
    assertUrl: async () => {},
    buildRequest: () => ({ url: 'https://example.com', headers: {}, body: {} }),
    parseResponse: (_p, value) => {
      const v = value as any;
      if (v.status && v.status !== 'completed') throw new Error('secret-token upstream details');
      return v.output_text || v.choices?.[0]?.message?.content || v.content?.[0]?.text || '';
    },
    fetch: async (_url, init) => {
      capture?.(JSON.parse(init!.body as string));
      return new Response(new ReadableStream({ start(c) { for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk)); c.close(); } }), { headers: { 'content-type': protocol === 'json' ? 'application/json' : 'text/event-stream' } });
    },
  };
}
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
test('chat stream handles split UTF-8/SSE boundaries, usage-only chunks and configured request', async () => {
  const data = sse({ choices: [{ delta: { content: '你好' }, finish_reason: null }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }) + 'data: [DONE]\r\n\r\n';
  let body: any;
  const result = await generateModelTransport({ ...settings, maxOutputTokens: 50, temperature: 0, inputPricePerMillion: 1, outputPricePerMillion: 2 }, 'hello', [], new AbortController().signal, deps('sse', [...data], v => { body = v; }));
  assert.equal(result.text, '你好'); assert.equal(result.usage.inputTokens, 10); assert.equal(result.usage.outputTokens, 2);
  assert.equal(result.usage.estimated, false); assert.equal(result.usage.estimatedCost, 0.000014);
  assert.equal(body.temperature, 0); assert.equal(body.max_tokens, 50); assert.equal(body.stream, true);
});
test('responses and anthropic streams normalize text and usage', async () => {
  const response = await generateModelTransport({ ...settings, protocol: 'responses' }, 'a', [], new AbortController().signal, deps('sse', [sse({ type: 'response.output_text.delta', delta: '正文' }), sse({ type: 'response.completed', response: { status: 'completed', output_text: '正文', usage: { input_tokens: 8, output_tokens: 3 } } })]));
  assert.equal(response.text, '正文'); assert.equal(response.usage.totalTokens, 11);
  const anthropic = await generateModelTransport({ ...settings, protocol: 'anthropic-messages' }, 'a', [], new AbortController().signal, deps('sse', [sse({ type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } }), sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: '结果' } }), sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }), sse({ type: 'message_stop' })]));
  assert.equal(anthropic.text, '结果'); assert.equal(anthropic.usage.totalTokens, 7);
});
test('JSON fallback is bounded and missing usage is clearly estimated', async () => {
  const value = JSON.stringify({ choices: [{ message: { content: 'ok' } }] });
  const result = await generateModelTransport(settings, 'abc', [], new AbortController().signal, deps('json', [value]));
  assert.equal(result.text, 'ok'); assert.equal(result.usage.estimated, true);
  await assert.rejects(generateModelTransport(settings, 'a', [], new AbortController().signal, { ...deps('json', [value]), maxResponseBytes: 2 }), (e: unknown) => e instanceof ModelTransportError && e.code === 'PROVIDER_RESPONSE_TOO_LARGE');
});
test('truncated, refused and malformed streams reject without exposing upstream details', async () => {
  for (const chunk of [sse({ choices: [{ delta: { content: 'partial' } }] }), sse({ choices: [{ finish_reason: 'length' }] }), sse({ error: { message: 'secret-token' } }), 'data: invalid\n\n']) {
    await assert.rejects(generateModelTransport(settings, 'a', [], new AbortController().signal, deps('sse', [chunk])), (e: unknown) => e instanceof ModelTransportError && !e.message.includes('secret-token'));
  }
});
test('per-call budgets reject before DNS checks, request construction or network admission', async () => {
  let calls = 0;
  const blocked: TransportDependencies = { ...deps('json', []), assertUrl: async () => { calls++; }, buildRequest: () => { calls++; throw new Error('must not build'); }, fetch: async () => { calls++; throw new Error('must not fetch'); } };
  for (const budget of [{ perCallBudgetTokens: 1 }, { maxEstimatedCostPerCall: 0 }, { maxEstimatedCostPerCall: 0, inputPricePerMillion: 1, outputPricePerMillion: 1 }]) {
    await assert.rejects(generateModelTransport({ ...settings, ...budget }, 'abc', [], new AbortController().signal, blocked), (error: unknown) => error instanceof ModelTransportError && error.code === 'MODEL_CAPABILITY_REJECTED');
  }
  assert.equal(calls, 0);
  const free = await generateModelTransport({ ...settings, maxEstimatedCostPerCall: 0, inputPricePerMillion: 0, outputPricePerMillion: 0 }, 'abc', [], new AbortController().signal, deps('json', [JSON.stringify({ choices: [{ message: { content: 'ok' } }] })]));
  assert.equal(free.usage.estimatedCost, 0);
});
test('preflight happens before network, cancellation interrupts a blocked reader', async () => {
  const base = deps('sse', []); base.fetch = async () => { throw new Error('must not fetch'); };
  await assert.rejects(generateModelTransport({ ...settings, vision: false }, 'a', [{ mime: 'image/png', data: 'x' }], new AbortController().signal, base), /视觉/);
  const controller = new AbortController();
  const task = generateModelTransport(settings, 'a', [], controller.signal, { ...base, fetch: async () => new Response(new ReadableStream({ start() { queueMicrotask(() => controller.abort()); } }), { headers: { 'content-type': 'text/event-stream' } }) });
  await assert.rejects(task, (e: unknown) => e instanceof DOMException && e.name === 'AbortError');
});
