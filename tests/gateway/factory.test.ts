import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { createGateway, createGateways, createGatewayOrChain, ChainedGateway, altModelFor } from '../../src/gateway/factory.js';
import { AnthropicGateway, GatewayError } from '../../src/gateway/gateway.js';
import { OpenAIGateway } from '../../src/gateway/openai.js';
import { loadConfig } from '../../src/config/config.js';

const policy = loadConfig(process.cwd()).policy;
const anthropicPolicy = { ...policy, llm: { ...policy.llm, provider: 'anthropic' as const } };
const openaiPolicy = { ...policy, llm: { ...policy.llm, provider: 'openai' as const } };

describe('createGateway', () => {
  it('anthropic policy → AnthropicGateway örneği', () => {
    expect(createGateway(anthropicPolicy)).toBeInstanceOf(AnthropicGateway);
  });
  it('openai policy → OpenAIGateway örneği', () => {
    expect(createGateway(openaiPolicy)).toBeInstanceOf(OpenAIGateway);
  });
});

// I3 (final fix wave): alt reviewer modeli provider-aware — openai provider'da alt reviewer'a
// geçilen model override'ı anthropic fallbackModel adı DEĞİL openai.fallbackModel olmalı
// (yanlış isim OpenAI gateway'de geçersiz model çağrısı üretir).
describe('altModelFor (I3)', () => {
  it('openai policy → openai.fallbackModel (anthropic fallback adı DEĞİL)', () => {
    expect(altModelFor(openaiPolicy)).toBe(openaiPolicy.llm.openai.fallbackModel);
    expect(altModelFor(openaiPolicy)).not.toBe(openaiPolicy.llm.fallbackModel);
  });
  it('anthropic policy → anthropic fallbackModel', () => {
    expect(altModelFor(anthropicPolicy)).toBe(anthropicPolicy.llm.fallbackModel);
  });
});

// R21 (faz 4 T6): cross-provider fallback — createGateways ayak listesi + ChainedGateway sıralı deneme.
// Anahtar kontrolü env stub ile simüle edilir (gerçek API çağrısı yok — fetch mock).
const Schema = z.object({ answer: z.string() });
const anthropicResponse = (text: string, status = 200) => new Response(
  JSON.stringify({ content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 50 } }), { status });
const openaiResponse = (text: string, status = 200) => new Response(
  JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }), { status });
const fallbackPolicy = { ...anthropicPolicy, llm: { ...anthropicPolicy.llm, crossProviderFallback: true } };

describe('createGateways + ChainedGateway (R21 cross-provider fallback)', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('(a) crossProviderFallback true + iki anahtar da var → 2 ayak (anthropic birincil + openai ikincil)', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k-anthropic');
    vi.stubEnv('OPENAI_API_KEY', 'k-openai');
    const legs = createGateways(fallbackPolicy);
    expect(legs).toHaveLength(2);
    expect(legs[0]).toBeInstanceOf(AnthropicGateway);
    expect(legs[1]).toBeInstanceOf(OpenAIGateway);
  });

  it('(b) cross-fallback: anthropic ayak HTTP 500 → openai ayak başarılı → complete ok döner', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k-anthropic');
    vi.stubEnv('OPENAI_API_KEY', 'k-openai');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.includes('api.anthropic.com') ? anthropicResponse('x', 500) : openaiResponse('{"answer":"ok"}');
    });
    vi.stubGlobal('fetch', fetchMock);
    const gateway = new ChainedGateway(createGateways(fallbackPolicy));
    const r = await gateway.complete({ system: 's', user: 'q', schema: Schema, runId: 'r' });
    expect(r.data.answer).toBe('ok');
    expect(r.usage.inputTokens).toBe(100);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('api.anthropic.com'))).toBe(true);
    expect(urls.some((u) => u.includes('api.openai.com'))).toBe(true);
  });

  // I2 (final fix wave, R21): req.model override (ör. alt-reviewer'ın claude-haiku-3-5'i) yalnız
  // BİRİNCİL ayğa iletilir; non-primary (openai) ayakta STRIP edilir — ayağa gövdede kendi policy
  // birincil modeli yazılır. Eski davranışta override aynen openai ayğına gidiyor, geçersiz
  // model adı çağrıyı garanti GatewayError'a düşürüyordu.
  it('(b2) I2: req.model override non-primary ayğa sızmaz — openai ayağı kendi policy modeliyle çağrılır', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k-anthropic');
    vi.stubEnv('OPENAI_API_KEY', 'k-openai');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      return url.includes('api.anthropic.com') ? anthropicResponse('x', 500) : openaiResponse('{"answer":"ok"}');
    });
    vi.stubGlobal('fetch', fetchMock);
    const gateway = new ChainedGateway(createGateways(fallbackPolicy));
    const r = await gateway.complete({ system: 's', user: 'q', schema: Schema, runId: 'r', model: 'claude-haiku-3-5' });
    expect(r.data.answer).toBe('ok');
    // birincil (anthropic) ayak req.model override'ını AYNEN alır — gövdedeki model override adı
    const anthBody = JSON.parse(String((fetchMock.mock.calls.filter((c) => String(c[0]).includes('api.anthropic.com'))[0]![1]!).body)) as { model: string };
    expect(anthBody.model).toBe('claude-haiku-3-5');
    // non-primary (openai) ayakta model STRIP — gövdedeki model ayağın KENDİ policy birincil
    // modelinden (openai.model) gelir; anthropic override adı gövdeye ASLA yazılmaz
    const oaBody = JSON.parse(String((fetchMock.mock.calls.filter((c) => String(c[0]).includes('api.openai.com'))[0]![1]!).body)) as { model: string };
    expect(oaBody.model).toBe(fallbackPolicy.llm.openai.model);
    expect(oaBody.model).not.toBe('claude-haiku-3-5');
  });

  it('(c) cross-fallback false → tek ayak (chain yok); HTTP 500 → GatewayError, openai denenmez', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k-anthropic');
    vi.stubEnv('OPENAI_API_KEY', 'k-openai'); // anahtar mevcut olsa bile cross=false → ikinci ayak yok
    const legs = createGateways({ ...anthropicPolicy, llm: { ...anthropicPolicy.llm, crossProviderFallback: false } });
    expect(legs).toHaveLength(1);
    expect(legs[0]).toBeInstanceOf(AnthropicGateway);
    expect(legs[0]).not.toBeInstanceOf(ChainedGateway);
    const fetchMock = vi.fn(async () => anthropicResponse('x', 500));
    vi.stubGlobal('fetch', fetchMock);
    await expect(legs[0].complete({ system: 's', user: 'q', schema: Schema, runId: 'r' })).rejects.toBeInstanceOf(GatewayError);
    expect(fetchMock.mock.calls.every((c) => String(c[0]).includes('api.anthropic.com'))).toBe(true);
  });

  it('(d) anahtar eksik ayak atlanır (OPENAI_API_KEY temiz) → tek ayak', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k-anthropic');
    vi.stubEnv('OPENAI_API_KEY', '');
    const legs = createGateways(fallbackPolicy);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toBeInstanceOf(AnthropicGateway);
  });

  it('(e) tüm ayaklar başarısız → GatewayError son neden mesajı tüm ayakların hatalarını içerir', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k-anthropic');
    vi.stubEnv('OPENAI_API_KEY', 'k-openai');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.includes('api.anthropic.com') ? anthropicResponse('x', 500) : openaiResponse('x', 503);
    });
    vi.stubGlobal('fetch', fetchMock);
    const gateway = new ChainedGateway(createGateways(fallbackPolicy));
    const err: unknown = await gateway.complete({ system: 's', user: 'q', schema: Schema, runId: 'r' }).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    const message = (err as Error).message;
    expect(message).toContain('HTTP 500'); // anthropic ayak hatası
    expect(message).toContain('HTTP 503'); // openai ayak hatası
    expect(message).toContain('claude-sonnet-4-5'); // anthropic ayak model raporu
    expect(message).toContain('gpt-4.1'); // openai ayak model raporu
  });

  it('hiçbir ayak yok (env tamamen temiz) → createGateways [] + ChainedGateway([]) complete GatewayError fırlatır', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    expect(createGateways(fallbackPolicy)).toHaveLength(0);
    const gateway = new ChainedGateway(createGateways(fallbackPolicy));
    await expect(gateway.complete({ system: 's', user: 'q', schema: Schema, runId: 'r' })).rejects.toBeInstanceOf(GatewayError);
  });
});

// R26b (faz 5 T3): CLI 5 gateway kurulum sitesinin duplike ternary'si tek kapıya iner —
// createGatewayOrChain seçim sözleşmesi: 0 ayak → GatewayError (fail-closed, KURULUM anında);
// 1 ayak → düz gateway (chain sarması YOK); çok ayak → ChainedGateway. BudgetedGateway sarması
// çağıran tarafta kalır (helper ham gateway/zincir döner).
describe('createGatewayOrChain (R26b)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('0 ayak (anahtarlar temiz) → GatewayError: Kullanılabilir gateway ayak yok (anahtarlar env\'de eksik)', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    expect(() => createGatewayOrChain(anthropicPolicy)).toThrow(GatewayError);
    expect(() => createGatewayOrChain(anthropicPolicy)).toThrow("Kullanılabilir gateway ayak yok (anahtarlar env'de eksik)");
  });

  it('1 ayak → düz gateway örneği (ChainedGateway DEĞİL)', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k-anthropic');
    vi.stubEnv('OPENAI_API_KEY', '');
    const gateway = createGatewayOrChain(anthropicPolicy); // cross=false → tek ayak
    expect(gateway).toBeInstanceOf(AnthropicGateway);
    expect(gateway).not.toBeInstanceOf(ChainedGateway);
  });

  it('2 ayak (crossProviderFallback + iki anahtar) → ChainedGateway örneği', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k-anthropic');
    vi.stubEnv('OPENAI_API_KEY', 'k-openai');
    const gateway = createGatewayOrChain(fallbackPolicy);
    expect(gateway).toBeInstanceOf(ChainedGateway);
  });
});
