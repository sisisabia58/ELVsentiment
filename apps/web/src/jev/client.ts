import type { ParsedJudgment } from "../domain/routing";
import { buildSystemOneBody, type TopicQuestion } from "./questions";

export { buildSystemOneBody, type TopicQuestion };

export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/systemone";
export const TYPESAFE_MODEL = "jev-1.14.0";
export const OPENROUTER_MODEL = "typesafe/jev-1.14";

const FALLBACK_STATUSES = new Set([402, 408, 429, 500, 502, 503, 504]);

type TransportResponse = { model: string; answers: Record<string, { type: string; noul?: number; choice?: string; confidence?: number }> };
type Transport = (body: unknown) => Promise<TransportResponse>;

export function shouldFallback(error: { status?: number; network?: boolean }): boolean {
  if (error.network) return true;
  return error.status !== undefined && FALLBACK_STATUSES.has(error.status);
}

export function parseSystemOne(payload: TransportResponse): ParsedJudgment {
  const sentiment = payload.answers.sentiment?.choice;
  if (sentiment !== "positive" && sentiment !== "neutral" && sentiment !== "negative") {
    throw new Error("invalid_sentiment");
  }
  const relevance = payload.answers.relevant?.noul;
  const confidence = payload.answers.sentiment?.confidence;
  if (typeof relevance !== "number" || typeof confidence !== "number") throw new Error("invalid_judgment");
  const topicNouls = Object.entries(payload.answers)
    .filter(([key]) => key.startsWith("topic_"))
    .map(([key, value]) => ({ id: key.slice("topic_".length), noul: value.noul ?? 0 }));
  return { relevanceNoul: relevance, sentiment, sentimentConfidence: confidence, topicNouls };
}

export async function scoreWithFallback(
  body: ReturnType<typeof buildSystemOneBody>,
  io: { primary: Transport; fallback: Transport },
  fallbackEnabled: boolean,
): Promise<{ provider: "typesafe" | "openrouter"; model: string; judgment: ParsedJudgment }> {
  try {
    const response = await io.primary(body);
    return { provider: "typesafe", model: response.model, judgment: parseSystemOne(response) };
  } catch (error) {
    const reason = typeof error === "object" && error !== null ? (error as { status?: number; network?: boolean }) : {};
    if (!fallbackEnabled || !shouldFallback(reason)) throw error;
    const response = await io.fallback({ ...body, model: OPENROUTER_MODEL });
    return { provider: "openrouter", model: response.model, judgment: parseSystemOne(response) };
  }
}
