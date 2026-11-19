import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { OpenAIGateway, GatewayError } from '../../src/gateway/openai.js';
import { loadConfig } from '../../src/config/config.js';

// Mock matris — gerçek API çağrısı yok (fetchImpl enjekte edilir). Fail-closed testi env'i
// geçici bozar; afterEach restore eder (aynı dosyadaki diğer testleri etkilemesin).
const KEY = (process.env.OPENAI_API_KEY ??= 'test-openai-key');

const policy = loadConfig(process.cwd()).policy;
const Schema = z.object({ answer: z.string() });
const api = (text: string, status = 200) => new Response(JSON.stringify({
  choices: [{ message: { content: text } }],
  usage: { prompt_tokens: 100, completion_tokens: 50 },
}), { status });
const noSleep = vi.fn(async () => {});
const sentBody = (call: unknown[]) => JSON.parse((call[1] as { body: string }).body);

afterEach(() => { process.env.OPENAI_API_KEY = KEY; });

describe('OpenAIGateway', () => {
  it('geçerli yanıt + maliyet hesabı (openai oranları)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(api('{"answer":"ok"}'));
    const g = new OpenAIGateway(policy, fetchMock as typeof fetch);
    const r = await g.complete({ system: 's', user: 'q', schema: Schema, runId: 'r' });
    expect(r.data.answer).toBe('ok');
    expect(r.usage.inputTokens).toBe(100);
    expect(r.usage.outputTokens).toBe(50);
    expect(r.usage.costUsd).toBeCloseTo(
      100 / 1000 * policy.llm.openai.costPer1kInput + 50 / 1000 * policy.llm.openai.costPer1kOutput, 6);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
    const sent = sentBody(fetchMock.mock.calls[0]);
    expect(sent.model).toBe(policy.llm.openai.model);
    expect(sent.response_format).toEqual({ type: 'json_object' });
    expect(sent.max_tokens).toBe(policy.llm.openai.maxTokens);
    expect(sent.messages[0].role).toBe('system');
    expect(sent.messages[0].content).toContain('ÇIKTI KURALI');
    expect(sent.messages[1]).toEqual({ role: 'user', content: 'q' });
  });
  it('bozuk JSON → retry → fallback model', async () => {
    // MAX_JSON_RETRIES=2 → primary 3 deneme (tümü bozuk), ardından fallback modelin ilk denemesi
    // başarılı: zincir 4 yanıt — model zinciri [primary, primary, primary, fallback] doğrulanır.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(api('metin'))
      .mockResolvedValueOnce(api('bozuk'))
      .mockResolvedValueOnce(api('yine bozuk'))
      .mockResolvedValueOnce(api('{"answer":"fb"}'));
    const g = new OpenAIGateway(policy, fetchMock as typeof fetch, noSleep);
    expect((await g.complete({ system: 's', user: 'q', schema: Schema, runId: 'r' })).data.answer).toBe('fb');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const models = fetchMock.mock.calls.map((c) => sentBody(c).model);
    expect(models).toEqual([policy.llm.openai.model, policy.llm.openai.model, policy.llm.openai.model, policy.llm.openai.fallbackModel]);
  });
  it('fallback da başarısız → GatewayError (son neden mesajı)', async () => {
    const g = new OpenAIGateway(policy, vi.fn().mockResolvedValue(api('bozuk')) as typeof fetch, noSleep);
    const err = await g.complete({ system: 's', user: 'q', schema: Schema, runId: 'r' }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as Error).message).toContain(`(model: ${policy.llm.openai.model})`);
    expect((err as Error).message).toContain('Son neden:');
  });
  it('OPENAI_API_KEY yok → GatewayError (fail-closed)', async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchMock = vi.fn();
    const g = new OpenAIGateway(policy, fetchMock as typeof fetch);
    await expect(g.complete({ system: 's', user: 'q', schema: Schema, runId: 'r' })).rejects.toBeInstanceOf(GatewayError);
    await expect(g.complete({ system: 's', user: 'q', schema: Schema, runId: 'r' }))
      .rejects.toThrow('OPENAI_API_KEY yok — openai provider seçilemez (fail-closed).');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('model override: req.model body\u2019de kullanılır', async () => {
    const fetchMock = vi.fn().mockResolvedValue(api('{"answer":"ok"}'));
    const g = new OpenAIGateway(policy, fetchMock as typeof fetch);
    await g.complete({ system: 's', user: 'q', schema: Schema, runId: 'r', model: 'ozel-openai-model' });
    expect(sentBody(fetchMock.mock.calls[0]).model).toBe('ozel-openai-model');
    const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toMatch(/^Bearer /);
  });
});
