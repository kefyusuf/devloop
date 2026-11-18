import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { AnthropicGateway, GatewayError } from '../../src/gateway/gateway.js';
import { loadConfig } from '../../src/config/config.js';

process.env.ANTHROPIC_API_KEY ??= 'test-key';

const policy = loadConfig(process.cwd()).policy;
const Schema = z.object({ answer: z.string() });
const api = (text: string, status = 200) => new Response(JSON.stringify({ content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 50 } }), { status });

describe('AnthropicGateway', () => {
  it('geçerli yanıt + maliyet hesabı', async () => {
    const g = new AnthropicGateway(policy, vi.fn().mockResolvedValue(api('{"answer":"ok"}')) as typeof fetch);
    const r = await g.complete({ system: 's', user: 'q', schema: Schema, runId: 'r' });
    expect(r.data.answer).toBe('ok');
    expect(r.usage.costUsd).toBeCloseTo(100 / 1000 * policy.llm.costPer1kInput + 50 / 1000 * policy.llm.costPer1kOutput, 6);
  });
  it('bozuk JSON → retry → fallback model', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(api('metin')).mockResolvedValueOnce(api('bozuk')).mockResolvedValueOnce(api('{"answer":"fb"}'));
    const g = new AnthropicGateway(policy, fetchMock as typeof fetch);
    expect((await g.complete({ system: 's', user: 'q', schema: Schema, runId: 'r' })).data.answer).toBe('fb');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('fallback da başarısız → GatewayError', async () => {
    const g = new AnthropicGateway(policy, vi.fn().mockResolvedValue(api('bozuk')) as typeof fetch);
    await expect(g.complete({ system: 's', user: 'q', schema: Schema, runId: 'r' })).rejects.toBeInstanceOf(GatewayError);
  });
  it('API 500 → GatewayError', async () => {
    const g = new AnthropicGateway(policy, vi.fn().mockResolvedValue(api('x', 500)) as typeof fetch);
    await expect(g.complete({ system: 's', user: 'q', schema: Schema, runId: 'r' })).rejects.toBeInstanceOf(GatewayError);
  });
  it('ağ hatası → GatewayError (ham TypeError değil)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const g = new AnthropicGateway(policy, fetchMock as typeof fetch);
    await expect(g.complete({ system: 's', user: 'q', schema: Schema, runId: 'r' })).rejects.toBeInstanceOf(GatewayError);
    expect(fetchMock).toHaveBeenCalledTimes(6); // 2 model × (2 retry + 1)
  });
  it('transport hatası → retry → başarı', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(api('{"answer":"ok"}'));
    const g = new AnthropicGateway(policy, fetchMock as typeof fetch);
    expect((await g.complete({ system: 's', user: 'q', schema: Schema, runId: 'r' })).data.answer).toBe('ok');
  });
});
