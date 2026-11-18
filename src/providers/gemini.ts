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

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

const FINISH: Record<string, string> = { STOP: "stop", MAX_TOKENS: "length" };

/** Google's Gemini API (generateContent). Assistant turns become "model" turns. */
export class GeminiProvider implements Provider {
  readonly name = "gemini";

  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly baseUrl = "https://generativelanguage.googleapis.com/v1beta",
  ) {}

  async chat(request: ProviderRequest, signal: AbortSignal): Promise<ChatResult> {
    const response = await this.post(`${request.model}:generateContent`, request, signal);
    const data = (await response.json()) as GeminiResponse;
    return {
      content: textOf(data),
      finishReason: FINISH[data.candidates?.[0]?.finishReason ?? ""] ?? "other",
      usage: usageOf(data),
    };
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const response = await this.post(
      `${request.model}:streamGenerateContent?alt=sse`,
      request,
      signal,
    );
    if (!response.body) {
      throw new ProviderError("gemini returned an empty stream", response.status, true);
    }
    let finishReason = "other";
    let usage = { promptTokens: 0, completionTokens: 0 };
    for await (const data of readSse(response.body)) {
      const chunk = JSON.parse(data) as GeminiResponse;
      const text = textOf(chunk);
      if (text) {
        yield { type: "delta", text };
      }
      const reason = chunk.candidates?.[0]?.finishReason;
      if (reason) {
        finishReason = FINISH[reason] ?? "other";
      }
      if (chunk.usageMetadata) {
        usage = usageOf(chunk);
      }
    }
    yield { type: "done", finishReason, usage };
  }

  private async post(
    path: string,
    request: ProviderRequest,
    signal: AbortSignal,
  ): Promise<Response> {
    const system = request.messages
      .filter((m) => m.role === "system")
      .map((m) => ({ text: m.content }));
    const body = {
      contents: request.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
      ...(system.length > 0 ? { systemInstruction: { parts: system } } : {}),
      generationConfig: { temperature: request.temperature, maxOutputTokens: request.maxTokens },
    };
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/models/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
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

function textOf(data: GeminiResponse): string {
  return (data.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("");
}

function usageOf(data: GeminiResponse): { promptTokens: number; completionTokens: number } {
  return {
    promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
    completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
  };
}
