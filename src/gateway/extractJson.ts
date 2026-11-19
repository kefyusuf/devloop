// R12 (faz 3 T6): gateway.ts'ten paylaşılan util'e taşındı — AnthropicGateway ve OpenAIGateway
// AYNI parse/retry ilkelerini kullanır (farklı endpoint/body/parse sadece transport farkıdır).
export const MAX_JSON_RETRIES = 2;

export function extractJson(text: string): unknown {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = m ? m[1] : text;
  const start = Math.min(...['{', '['].map((c) => { const i = candidate.indexOf(c); return i === -1 ? Number.MAX_SAFE_INTEGER : i; }));
  return JSON.parse(candidate.slice(start === Number.MAX_SAFE_INTEGER ? 0 : start));
}
