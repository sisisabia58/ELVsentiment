export type JevError = { status?: number; network?: boolean; timeout?: boolean };

export function isRetryable(error: JevError): boolean {
  if (error.timeout) return true;
  if (error.status === 429) return true;
  if (error.status !== undefined && error.status >= 500 && error.status <= 599) return true;
  return false;
}

export function backoffDelayMs(attempt: number, random: () => number): number {
  const base = Math.min(200 * 2 ** attempt, 5000);
  return base + random() * (base / 2);
}

export function redactAuthorization(message: string, apiKey?: string): string {
  let redacted = message.replace(/\bauthorization\s*:\s*bearer\s+\S+/gi, "[redacted]");
  redacted = redacted.replace(/\bbearer\s+\S+/gi, "[redacted]");
  if (apiKey) {
    redacted = redacted.split(apiKey).join("[redacted]");
  }
  return redacted;
}

type PostFn = (body: unknown, apiKey: string) => Promise<unknown>;

function asJevError(error: unknown): JevError {
  if (typeof error === "object" && error !== null) return error as JevError;
  return {};
}

function throwRedacted(error: unknown, apiKey: string): never {
  if (error instanceof Error) {
    throw new Error(redactAuthorization(error.message, apiKey));
  }
  throw error;
}

function logRedacted(error: unknown, apiKey: string, log: (message: string) => void): void {
  if (error instanceof Error) {
    log(redactAuthorization(error.message, apiKey));
  }
}

export async function postWithRetry(
  post: PostFn,
  body: unknown,
  apiKey: string,
  options: {
    sleep?: (ms: number) => Promise<void>;
    log?: (message: string) => void;
    random?: () => number;
  } = {},
): Promise<unknown> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const maxAttempts = 4;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await post(body, apiKey);
    } catch (error) {
      const retryable = isRetryable(asJevError(error));
      const isLast = attempt === maxAttempts - 1;
      if (!retryable || isLast) {
        if (options.log) logRedacted(error, apiKey, options.log);
        throwRedacted(error, apiKey);
      }
      if (options.log) logRedacted(error, apiKey, options.log);
      await sleep(backoffDelayMs(attempt, random));
    }
  }

  throw new Error("unreachable");
}
