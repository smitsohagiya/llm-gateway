import {
  ProviderError,
  type ChatResult,
  type Provider,
  type ProviderRequest,
  type StreamEvent,
} from "./types.js";

/**
 * A deterministic provider for tests and demos, so the gateway runs without any API key.
 *
 * Models:
 * - `echo` replies "Echo: <last user message>".
 * - `flaky` fails every call with a retryable 503, to show fallbacks.
 * - `slow` waits `slowMs` before answering, to show timeouts.
 */
export class MockProvider implements Provider {
  readonly name = "mock";

  constructor(private readonly slowMs = 5_000) {}

  async chat(request: ProviderRequest, signal: AbortSignal): Promise<ChatResult> {
    await this.behave(request.model, signal);
    const content = reply(request);
    return { content, finishReason: "stop", usage: usage(request, content) };
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    await this.behave(request.model, signal);
    const content = reply(request);
    const words = content.split(" ");
    for (const [index, word] of words.entries()) {
      yield { type: "delta", text: index === 0 ? word : ` ${word}` };
    }
    yield { type: "done", finishReason: "stop", usage: usage(request, content) };
  }

  private async behave(model: string, signal: AbortSignal): Promise<void> {
    if (model === "flaky") {
      throw new ProviderError("mock flaky model is unavailable", 503, true);
    }
    if (model === "slow") {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.slowMs);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new ProviderError("mock slow model timed out", undefined, true));
        });
      });
    }
  }
}

function reply(request: ProviderRequest): string {
  const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
  return `Echo: ${lastUser?.content ?? ""}`;
}

function countTokens(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function usage(
  request: ProviderRequest,
  content: string,
): { promptTokens: number; completionTokens: number } {
  return {
    promptTokens: request.messages.reduce((sum, m) => sum + countTokens(m.content), 0),
    completionTokens: countTokens(content),
  };
}
