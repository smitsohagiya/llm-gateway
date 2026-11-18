/** Shapes shared by every provider adapter. Adapters translate these to and from each vendor's API. */

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface ProviderRequest {
  /** The vendor's model name, e.g. "gpt-4o-mini". */
  model: string;
  messages: ChatMessage[];
  temperature?: number | undefined;
  maxTokens?: number | undefined;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResult {
  content: string;
  /** OpenAI-style reason: "stop", "length" or "other". */
  finishReason: string;
  usage: Usage;
}

export type StreamEvent =
  { type: "delta"; text: string } | { type: "done"; finishReason: string; usage: Usage };

export interface Provider {
  readonly name: string;
  chat(request: ProviderRequest, signal: AbortSignal): Promise<ChatResult>;
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
}

export type FetchFn = typeof fetch;

/** A failed provider call. `retryable` errors are retried and then fall back to the next target. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Turn a non-2xx response into a ProviderError. 408, 409, 429 and 5xx are worth retrying. */
export async function errorFromResponse(
  provider: string,
  response: Response,
): Promise<ProviderError> {
  const body = await response.text().catch(() => "");
  const retryable = [408, 409, 429].includes(response.status) || response.status >= 500;
  return new ProviderError(
    `${provider} returned ${String(response.status)}: ${body.slice(0, 200)}`,
    response.status,
    retryable,
  );
}

/** Network failures and timeouts are retryable; everything else is passed through unchanged. */
export function asProviderError(provider: string, error: unknown): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(`${provider} request failed: ${message}`, undefined, true);
}
