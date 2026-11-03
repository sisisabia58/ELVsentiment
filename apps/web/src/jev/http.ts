import { OPENROUTER_URL, TYPESAFE_URL } from "./client";

export async function postSystemOne(
  url: string,
  body: unknown,
  apiKey: string,
  timeoutMs = 20000,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof DOMException && error.name === "AbortError") {
      throw { timeout: true };
    }
    if (error instanceof TypeError) {
      throw { network: true };
    }
    throw error;
  }
  clearTimeout(timer);
  if (!response.ok) throw { status: response.status };
  return response.json();
}

export const primaryTransport = (apiKey: string) => (body: unknown) => postSystemOne(TYPESAFE_URL, body, apiKey);
export const fallbackTransport = (apiKey: string) => (body: unknown) => postSystemOne(OPENROUTER_URL, body, apiKey);
