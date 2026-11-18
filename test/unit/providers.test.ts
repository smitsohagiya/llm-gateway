import { describe, expect, it } from "vitest";

import { AnthropicProvider } from "../../src/providers/anthropic.js";
import { GeminiProvider } from "../../src/providers/gemini.js";
import { MockProvider } from "../../src/providers/mock.js";
import { OpenAIProvider } from "../../src/providers/openai.js";
import {
  ProviderError,
  type Provider,
  type ProviderRequest,
  type StreamEvent,
} from "../../src/providers/types.js";
import { fakeFetch, json, streamResponse } from "../helpers/fake-fetch.js";

const request: ProviderRequest = {
  model: "m1",
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello" },
    { role: "user", content: "Bye" },
  ],
  temperature: 0,
  maxTokens: 50,
};
const signal = new AbortController().signal;

async function events(provider: Provider): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of provider.stream(request, signal)) out.push(event);
  return out;
}

describe("OpenAIProvider", () => {
  it("sends the chat completions request and maps the answer", async () => {
    const { fetch, calls } = fakeFetch([
      json({
        choices: [{ message: { content: "Hey" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 1 },
      }),
    ]);
    const result = await new OpenAIProvider("sk-test", fetch).chat(request, signal);
    expect(result).toEqual({
      content: "Hey",
      finishReason: "stop",
      usage: { promptTokens: 7, completionTokens: 1 },
    });
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.headers.authorization).toBe("Bearer sk-test");
    expect(calls[0]?.body).toMatchObject({ model: "m1", max_tokens: 50, temperature: 0 });
  });

  it("streams deltas and reports usage from the last chunk", async () => {
    const { fetch, calls } = fakeFetch([
      streamResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
      ]),
    ]);
    expect(await events(new OpenAIProvider("k", fetch))).toEqual([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      { type: "done", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 2 } },
    ]);
    expect(calls[0]?.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it("marks 429 and 5xx as retryable and 400 as final", async () => {
    const { fetch } = fakeFetch([json({}, 429), json({}, 400), new TypeError("fetch failed")]);
    const provider = new OpenAIProvider("k", fetch);
    await expect(provider.chat(request, signal)).rejects.toMatchObject({
      status: 429,
      retryable: true,
    });
    await expect(provider.chat(request, signal)).rejects.toMatchObject({
      status: 400,
      retryable: false,
    });
    await expect(provider.chat(request, signal)).rejects.toMatchObject({ retryable: true });
  });
});

describe("AnthropicProvider", () => {
  it("moves system messages to the system field and maps the answer", async () => {
    const { fetch, calls } = fakeFetch([
      json({
        content: [{ type: "text", text: "Hey" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 9, output_tokens: 2 },
      }),
    ]);
    const result = await new AnthropicProvider("ak", fetch).chat(request, signal);
    expect(result).toEqual({
      content: "Hey",
      finishReason: "stop",
      usage: { promptTokens: 9, completionTokens: 2 },
    });
    expect(calls[0]?.headers["x-api-key"]).toBe("ak");
    expect(calls[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0]?.body.system).toBe("Be brief.");
    expect(calls[0]?.body.messages).toHaveLength(3);
  });

  it("streams text deltas and collects usage from the message events", async () => {
    const { fetch } = fakeFetch([
      streamResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":1}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    ]);
    expect(await events(new AnthropicProvider("ak", fetch))).toEqual([
      { type: "delta", text: "Hi" },
      { type: "done", finishReason: "length", usage: { promptTokens: 4, completionTokens: 1 } },
    ]);
  });
});

describe("GeminiProvider", () => {
  it("uses model turns and systemInstruction, and maps the answer", async () => {
    const { fetch, calls } = fakeFetch([
      json({
        candidates: [{ content: { parts: [{ text: "Hey" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 1 },
      }),
    ]);
    const result = await new GeminiProvider("gk", fetch).chat(request, signal);
    expect(result).toEqual({
      content: "Hey",
      finishReason: "stop",
      usage: { promptTokens: 6, completionTokens: 1 },
    });
    expect(calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/m1:generateContent",
    );
    const contents = calls[0]?.body.contents as { role: string }[];
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(calls[0]?.body.systemInstruction).toEqual({ parts: [{ text: "Be brief." }] });
  });

  it("streams over SSE", async () => {
    const { fetch, calls } = fakeFetch([
      streamResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"He"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"y"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1}}\n\n',
      ]),
    ]);
    expect(await events(new GeminiProvider("gk", fetch))).toEqual([
      { type: "delta", text: "He" },
      { type: "delta", text: "y" },
      { type: "done", finishReason: "stop", usage: { promptTokens: 3, completionTokens: 1 } },
    ]);
    expect(calls[0]?.url).toContain(":streamGenerateContent?alt=sse");
  });
});

describe("MockProvider", () => {
  it("echoes, streams word by word and fails on demand", async () => {
    const mock = new MockProvider(10);
    expect((await mock.chat({ ...request, model: "echo" }, signal)).content).toBe("Echo: Bye");
    await expect(mock.chat({ ...request, model: "flaky" }, signal)).rejects.toBeInstanceOf(
      ProviderError,
    );
    const controller = new AbortController();
    const slow = mock.chat({ ...request, model: "slow" }, controller.signal);
    controller.abort();
    await expect(slow).rejects.toMatchObject({ retryable: true });
  });
});
