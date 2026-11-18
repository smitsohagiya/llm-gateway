import { readSse } from "./sse.js";
import {
  asProviderError,
  errorFromResponse,
  ProviderError,
  type ChatMessage,
  type ChatResult,
  type FetchFn,
  type Provider,
  type ProviderRequest,
  type StreamEvent,
} from "./types.js";

interface AnthropicResponse {
  content: { type: string; text?: string }[];
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

interface AnthropicEvent {
  type: string;
  message?: { usage?: { input_tokens?: number } };
  delta?: { type?: string; text?: string; stop_reason?: string | null };
  usage?: { output_tokens?: number };
}

const FINISH: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
};

/** Anthropic's Messages API. System messages move to the top-level `system` field. */
export class AnthropicProvider implements Provider {
  readonly name = "anthropic";

  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly baseUrl = "https://api.anthropic.com/v1",
  ) {}

  async chat(request: ProviderRequest, signal: AbortSignal): Promise<ChatResult> {
    const response = await this.post(this.body(request, false), signal);
    const data = (await response.json()) as AnthropicResponse;
    return {
      content: data.content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join(""),
      finishReason: FINISH[data.stop_reason ?? ""] ?? "other",
      usage: { promptTokens: data.usage.input_tokens, completionTokens: data.usage.output_tokens },
    };
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const response = await this.post(this.body(request, true), signal);
    if (!response.body) {
      throw new ProviderError("anthropic returned an empty stream", response.status, true);
    }
    let promptTokens = 0;
    let completionTokens = 0;
    let finishReason = "other";
    for await (const data of readSse(response.body)) {
      const event = JSON.parse(data) as AnthropicEvent;
      if (event.type === "message_start") {
        promptTokens = event.message?.usage?.input_tokens ?? 0;
      } else if (event.type === "content_block_delta" && event.delta?.text) {
        yield { type: "delta", text: event.delta.text };
      } else if (event.type === "message_delta") {
        completionTokens = event.usage?.output_tokens ?? completionTokens;
        finishReason = FINISH[event.delta?.stop_reason ?? ""] ?? finishReason;
      }
    }
    yield { type: "done", finishReason, usage: { promptTokens, completionTokens } };
  }

  private body(request: ProviderRequest, stream: boolean): Record<string, unknown> {
    const system = request.messages.filter((m) => m.role === "system").map((m) => m.content);
    const messages: ChatMessage[] = request.messages.filter((m) => m.role !== "system");
    return {
      model: request.model,
      max_tokens: request.maxTokens ?? 1024,
      temperature: request.temperature,
      ...(system.length > 0 ? { system: system.join("\n\n") } : {}),
      messages,
      ...(stream ? { stream: true } : {}),
    };
  }

  private async post(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw asProviderError(this.name, error);
    }
    if (!response.ok) {
      throw await errorFromResponse(this.name, response);
    }
    return response;
  }
}
