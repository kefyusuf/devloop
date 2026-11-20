import { z } from 'zod';
import type { Policy } from '../config/config.js';
import type { LlmGateway, TokenUsage } from './gateway.js';
import { AnthropicGateway, GatewayError } from './gateway.js';
import { OpenAIGateway } from './openai.js';

// R12 (faz 3 T6): provider seçimi tek kapı — CLI (run/review-diff/eval/evolve) doğrudan
// AnthropicGateway yerine BURADAN kurar; openai provider + OPENAI_API_KEY yolu açılır.
export function createGateway(policy: Policy): LlmGateway {
  return policy.llm.provider === 'openai' ? new OpenAIGateway(policy) : new AnthropicGateway(policy);
}

// R21 (faz 4 T6): cross-provider fallback — ayak listesi kurar. Sıra: birincil (policy.llm.provider)
// önce; crossProviderFallback true ise DİĞER sağlayıcı ikinci ayak. Her ayak ANAHTAR-DURUM
// filtresinden geçer: anthropic → ANTHROPIC_API_KEY, openai → OPENAI_API_KEY; anahtarsız ayak
// ATLANIR (fail-closed değil — explicit opsiyonel genişletme). Hiçbir ayak kurulamadıysa boş dizi
// döner — ChainedGateway.complete o durumda GatewayError fırlatır (caller'ın fail-closed kapısı).
export function createGateways(policy: Policy): LlmGateway[] {
  const hasKey = (p: 'anthropic' | 'openai'): boolean =>
    p === 'anthropic' ? Boolean(process.env.ANTHROPIC_API_KEY) : Boolean(process.env.OPENAI_API_KEY);
  const other: 'anthropic' | 'openai' = policy.llm.provider === 'anthropic' ? 'openai' : 'anthropic';
  const providers: Array<'anthropic' | 'openai'> =
    policy.llm.crossProviderFallback ? [policy.llm.provider, other] : [policy.llm.provider];
  return providers
    .filter((p) => hasKey(p))
    .map((p) => (p === 'openai' ? new OpenAIGateway(policy) : new AnthropicGateway(policy)));
}

// R21 (faz 4 T6): sıralı gateway zinciri — ayakları sırayla dener; ilk başarılı yanıt döner
// (usage başarılı ayaktan gelir). GatewayError'lar toplanır; TÜM ayaklar başarısızsa tek
// GatewayError fırlatır — son neden mesajı tüm ayakların hatalarını içerir (join). Boş zincir
// (hiçbir ayak kurulamadı) anında GatewayError. ChainedGateway SIRAYI ve model sahiplğini
// yönetir: req.model override'ı yalnız BİRİNCİL ayğa aynen iletilir; non-primary ayaklarda
// STRIP edilir — hüküm (I2 final fix wave, R21): req.model (ör. alt-reviewer override'ı
// claude-haiku-3-5) diğer sağlayıcının namespace'inde geçersizdir; fallback ayağı diğer
// sağlayıcının birincil modeliyle devreye girmelidir (gateway ayakları policy'sinin kendi
// birincil modelini kullanır). Birincil ayakta `req.model ?? policy birincil modeli` davranışı
// (faz 3 OpenAIGateway/AntropicGateway sözleşmesi) aynen korunur.
export class ChainedGateway implements LlmGateway {
  constructor(private readonly gateways: LlmGateway[]) {}
  async complete<T>(req: { system: string; user: string; schema: z.ZodType<T>; runId: string; model?: string }): Promise<{ data: T; usage: TokenUsage }> {
    if (this.gateways.length === 0) {
      throw new GatewayError("Gateway zinciri boş — kurulabilen ayak yok (sağlayıcı anahtarları env'de mevcut değil).");
    }
    const errors: string[] = [];
    for (let i = 0; i < this.gateways.length; i++) {
      const leg = this.gateways[i];
      // Non-primary ayak kendi policy birincil modelini kullanır (R21) — req.model strip.
      const legReq = i === 0 ? req : { ...req, model: undefined };
      try {
        return await leg.complete(legReq);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    throw new GatewayError(`Tüm gateway ayakları başarısız (${errors.length} ayak). Son neden: ${errors.join(' | ')}`);
  }
}

// I3 (final fix wave): alt (ikincil) reviewer modeli provider-aware — alt reviewer stage'lerine
// geçilen `model` override'ı Anthropic namespace'inde hardcode'landığında openai provider'da
// YANLIŞ model (anthropic fallbackModel adı) OpenAI gateway'e gidiyordu. Tek kapı: openai
// provider'da openai.fallbackModel, aksi halde anthropic fallbackModel.
export function altModelFor(policy: Policy): string {
  return policy.llm.provider === 'openai' ? policy.llm.openai.fallbackModel : policy.llm.fallbackModel;
}
