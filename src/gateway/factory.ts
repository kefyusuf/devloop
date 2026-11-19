import type { Policy } from '../config/config.js';
import type { LlmGateway } from './gateway.js';
import { AnthropicGateway } from './gateway.js';
import { OpenAIGateway } from './openai.js';

// R12 (faz 3 T6): provider seçimi tek kapı — CLI (run/review-diff/eval/evolve) doğrudan
// AnthropicGateway yerine BURADAN kurar; openai provider + OPENAI_API_KEY yolu açılır.
export function createGateway(policy: Policy): LlmGateway {
  return policy.llm.provider === 'openai' ? new OpenAIGateway(policy) : new AnthropicGateway(policy);
}

// I3 (final fix wave): alt (ikincil) reviewer modeli provider-aware — alt reviewer stage'lerine
// geçilen `model` override'ı Anthropic namespace'inde hardcode'landığında openai provider'da
// YANLIŞ model (anthropic fallbackModel adı) OpenAI gateway'e gidiyordu. Tek kapı: openai
// provider'da openai.fallbackModel, aksi halde anthropic fallbackModel.
export function altModelFor(policy: Policy): string {
  return policy.llm.provider === 'openai' ? policy.llm.openai.fallbackModel : policy.llm.fallbackModel;
}
