import { describe, it, expect } from 'vitest';
import { createGateway, altModelFor } from '../../src/gateway/factory.js';
import { AnthropicGateway } from '../../src/gateway/gateway.js';
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
