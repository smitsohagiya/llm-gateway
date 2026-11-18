import { readFileSync } from "node:fs";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { loadEnv } from "../../src/config/env.js";
import { parseGatewayConfig } from "../../src/config/gateway-config.js";
import { MockProvider } from "../../src/providers/mock.js";

const example = JSON.parse(readFileSync("config/gateway.example.json", "utf8")) as Record<
  string,
  unknown
>;

function app(budget = 100_000): FastifyInstance {
  const config = parseGatewayConfig(
    { ...example, tenants: [{ name: "demo", apiKey: "demo-key", dailyTokenBudget: budget }] },
    {},
  );
  return buildApp({
    env: loadEnv({ LOG_LEVEL: "silent" }),
    config,
    providers: new Map([["mock", new MockProvider(10)]]),
    sleep: () => Promise.resolve(),
  });
}

const auth = { authorization: "Bearer demo-key" };
const chat = { model: "demo", messages: [{ role: "user", content: "hello there" }] };
let server: FastifyInstance | undefined;

afterEach(async () => {
  await server?.close();
});

describe("HTTP API", () => {
  it("needs a valid API key", async () => {
    server = app();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chat,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { type: "invalid_api_key" } });
  });

  it("answers in the OpenAI format with routing headers", async () => {
    server = app();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: chat,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-gateway-target"]).toBe("mock:echo");
    expect(response.headers["x-gateway-attempts"]).toBe("3");
    expect(response.json()).toMatchObject({
      object: "chat.completion",
      model: "demo",
      choices: [
        { message: { role: "assistant", content: "Echo: hello there" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    });
  });

  it("serves repeated deterministic requests from the cache", async () => {
    server = app();
    const payload = { ...chat, temperature: 0 };
    await server.inject({ method: "POST", url: "/v1/chat/completions", headers: auth, payload });
    const second = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload,
    });
    expect(second.headers["x-cache"]).toBe("hit");
  });

  it("streams server-sent events that end with [DONE]", async () => {
    server = app();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { ...chat, stream: true },
    });
    expect(response.headers["content-type"]).toBe("text/event-stream");
    const events = response.body.trim().split("\n\n");
    expect(events.at(-1)).toBe("data: [DONE]");
    const text = events
      .slice(0, -1)
      .map((e) => JSON.parse(e.slice(6)) as { choices: { delta: { content?: string } }[] })
      .map((e) => e.choices[0]?.delta.content ?? "")
      .join("");
    expect(text).toBe("Echo: hello there");
  });

  it("rejects invalid bodies and unknown models", async () => {
    server = app();
    const invalid = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "demo", messages: [] },
    });
    expect(invalid.json()).toMatchObject({ error: { type: "invalid_request_error" } });
    const unknown = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { ...chat, model: "gpt-9" },
    });
    expect(unknown.statusCode).toBe(400);
  });

  it("returns 429 once the budget is used up", async () => {
    server = app(5);
    await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: chat,
    });
    const blocked = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: chat,
    });
    expect(blocked.statusCode).toBe(429);
  });

  it("lists models, reports usage and exposes metrics", async () => {
    server = app();
    await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: chat,
    });
    const models = (await server.inject({ url: "/v1/models", headers: auth })).json<{
      data: { id: string }[];
    }>();
    expect(models.data.map((m) => m.id)).toContain("demo");
    expect((await server.inject({ url: "/v1/usage", headers: auth })).json()).toMatchObject({
      tenant: "demo",
      tokensUsed: 5,
    });
    const metrics = (await server.inject({ url: "/metrics" })).body;
    expect(metrics).toContain(
      'gateway_requests_total{route="demo",target="mock:echo",status="ok"} 1',
    );
    expect(metrics).toContain('gateway_fallbacks_total{route="demo",from="mock:flaky"} 1');
    expect((await server.inject({ url: "/health" })).json()).toEqual({ status: "ok" });
  });
});
