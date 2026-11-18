import { readSse } from "./sse.js";
import {
  asProviderError,
  errorFromResponse,
  ProviderError,
  type ChatResult,
  type FetchFn,
  type Provider,
  type ProviderRequest,
  type StreamEvent,
} from "./types.js";

interface OpenAIResponse {
  choices: { message: { content: string | null }; finish_reason: string | null }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface OpenAIChunk {
  choices: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
}

/** OpenAI's chat completions API. Also works with any OpenAI-compatible server via `baseUrl`. */
export class OpenAIProvider implements Provider {
  readonly name: string;

  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly baseUrl = "https://api.openai.com/v1",
    name = "openai",
  ) {
    this.name = name;
  }

  async chat(request: ProviderRequest, signal: AbortSignal): Promise<ChatResult> {
    const response = await this.post(this.body(request, false), signal);
    const data = (await response.json()) as OpenAIResponse;
    const choice = data.choices[0];
    return {
      content: choice?.message.content ?? "",
      finishReason: choice?.finish_reason ?? "other",
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const response = await this.post(this.body(request, true), signal);
    if (!response.body) {
      throw new ProviderError(`${this.name} returned an empty stream`, response.status, true);
    }
    let finishReason = "other";
    let usage = { promptTokens: 0, completionTokens: 0 };
    for await (const data of readSse(response.body)) {
      if (data === "[DONE]") {
        break;
      }
      const chunk = JSON.parse(data) as OpenAIChunk;
      const choice = chunk.choices[0];
      const text = choice?.delta?.content;
      if (text) {
        yield { type: "delta", text };
      }
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
        };
      }
    }
    yield { type: "done", finishReason, usage };
  }

  private body(request: ProviderRequest, stream: boolean): Record<string, unknown> {
    return {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
  }

  private async post(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
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
