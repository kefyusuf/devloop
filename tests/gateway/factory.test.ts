import { describe, it, expect } from 'vitest';
import { createGateway } from '../../src/gateway/factory.js';
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
