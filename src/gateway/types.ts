import { z } from 'zod';

// R12 (faz 3 T6): LlmGateway ortak tipleri — AnthropicGateway (gateway.ts) ve OpenAIGateway
// (openai.ts) BURADAN kullanır; gateway.ts geriye dönük uyum için re-export eder
// (mevcut importer'lar gateway.js'ten import etmeye devam eder).
export interface TokenUsage { inputTokens: number; outputTokens: number; costUsd: number }
export class GatewayError extends Error {}

export interface LlmGateway {
  complete<T>(req: { system: string; user: string; schema: z.ZodType<T>; runId: string; model?: string }): Promise<{ data: T; usage: TokenUsage }>;
}
