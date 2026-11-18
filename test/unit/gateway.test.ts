import { describe, expect, it } from "vitest";

import { parseGatewayConfig, type GatewayConfig } from "../../src/config/gateway-config.js";
import { BudgetTracker, type Tenant } from "../../src/gateway/budget.js";
import { ResponseCache } from "../../src/gateway/cache.js";
import { CircuitBreaker } from "../../src/gateway/circuit-breaker.js";
import { GatewayError } from "../../src/gateway/errors.js";
import { Gateway, type ChatRequest } from "../../src/gateway/gateway.js";
import { createMetrics } from "../../src/gateway/metrics.js";
import { MockProvider } from "../../src/providers/mock.js";
import {
  ProviderError,
  type ChatResult,
  type Provider,
  type StreamEvent,
} from "../../src/providers/types.js";

const tenant: Tenant = { name: "t", dailyTokenBudget: 1_000 };
const hi: ChatRequest = { model: "demo", messages: [{ role: "user", content: "hi" }] };

class FinalError implements Provider {
  readonly name = "fake";
  calls = 0;
  chat(): Promise<ChatResult> {
    this.calls += 1;
    return Promise.reject(new ProviderError("bad request", 400, false));
  }
  // eslint-disable-next-line require-yield
  async *stream(): AsyncGenerator<StreamEvent> {
    await Promise.resolve();
    throw new ProviderError("bad request", 400, false);
  }
}

function makeConfig(extra: Record<string, unknown> = {}): GatewayConfig {
  return parseGatewayConfig(
    {
      tenants: [{ name: "t", apiKey: "k", dailyTokenBudget: 1_000 }],
      routes: {
        demo: ["mock:flaky", "mock:echo"],
        final: ["fake:x", "mock:echo"],
        slow: ["mock:slow", "mock:echo"],
        missing: ["openai:gpt-4o-mini", "mock:echo"],
        broken: ["mock:flaky"],
      },
      prices: { "mock:echo": { input: 1, output: 2 } },
      retries: 1,
      circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 },
      ...extra,
    },
    {},
  );
}

function makeGateway(
  config = makeConfig(),
  extra: Provider[] = [],
): { gateway: Gateway; budget: BudgetTracker } {
  const providers = new Map<string, Provider>([["mock", new MockProvider(1_000)]]);
  for (const provider of extra) providers.set(provider.name, provider);
  const budget = new BudgetTracker();
  const gateway = new Gateway({
    config,
    providers,
    cache: new ResponseCache(10, 60_000),
    budget,
    breaker: new CircuitBreaker(
      config.circuitBreaker.failureThreshold,
      config.circuitBreaker.cooldownMs,
    ),
    metrics: createMetrics(),
    sleep: () => Promise.resolve(),
  });
  return { gateway, budget };
}

describe("Gateway.complete", () => {
  it("retries a failing target, then falls back to the next one", async () => {
    const { gateway } = makeGateway();
    const completion = await gateway.complete(tenant, hi);
    expect(completion.target).toBe("mock:echo");
    expect(completion.attempts).toBe(3);
    expect(completion.result.content).toBe("Echo: hi");
  });

  it("opens the circuit after repeated failures and skips that target", async () => {
    const { gateway } = makeGateway();
    await gateway.complete(tenant, hi);
    await gateway.complete(tenant, hi);
    expect((await gateway.complete(tenant, hi)).attempts).toBe(1);
  });

  it("does not retry errors that are not retryable", async () => {
    const fake = new FinalError();
    const { gateway } = makeGateway(makeConfig(), [fake]);
    const completion = await gateway.complete(tenant, { ...hi, model: "final" });
    expect(fake.calls).toBe(1);
    expect(completion.attempts).toBe(2);
  });

  it("times out slow targets and falls back", async () => {
    const { gateway } = makeGateway(makeConfig({ timeoutMs: 20 }));
    expect((await gateway.complete(tenant, { ...hi, model: "slow" })).target).toBe("mock:echo");
  });

  it("skips providers without credentials", async () => {
    const { gateway } = makeGateway();
    expect((await gateway.complete(tenant, { ...hi, model: "missing" })).attempts).toBe(1);
  });

  it("caches answers to deterministic requests only", async () => {
    const { gateway } = makeGateway();
    const request = { ...hi, temperature: 0 };
    expect((await gateway.complete(tenant, request)).cached).toBe(false);
    const again = await gateway.complete(tenant, request);
    expect(again).toMatchObject({ cached: true, attempts: 0, target: "mock:echo" });
    expect((await gateway.complete(tenant, hi)).cached).toBe(false);
  });

  it("records tokens and cost, and refuses requests once the budget is spent", async () => {
    const { gateway, budget } = makeGateway();
    const small: Tenant = { name: "small", dailyTokenBudget: 3 };
    await gateway.complete(small, { ...hi, model: "mock:echo" });
    expect(budget.snapshot(small)).toMatchObject({
      tokensUsed: 3,
      tokensRemaining: 0,
      costUsd: 0.000005,
    });
    await expect(gateway.complete(small, hi)).rejects.toMatchObject({
      status: 429,
      code: "budget_exceeded",
    });
  });

  it("rejects unknown models and reports when every target fails", async () => {
    const { gateway } = makeGateway();
    await expect(gateway.complete(tenant, { ...hi, model: "nope" })).rejects.toBeInstanceOf(
      GatewayError,
    );
    await expect(gateway.complete(tenant, { ...hi, model: "broken" })).rejects.toMatchObject({
      status: 502,
    });
    expect(gateway.models()).toContain("demo");
  });
});

describe("Gateway.stream", () => {
  it("falls back before the first token and records usage when done", async () => {
    const { gateway, budget } = makeGateway();
    const started = await gateway.stream(tenant, hi);
    let text = "";
    for await (const event of started.events) if (event.type === "delta") text += event.text;
    expect(started.target).toBe("mock:echo");
    expect(text).toBe("Echo: hi");
    expect(budget.snapshot(tenant).tokensUsed).toBe(3);
  });

  it("fails when no target can start", async () => {
    const { gateway } = makeGateway(makeConfig(), [new FinalError()]);
    await expect(gateway.stream(tenant, { ...hi, model: "broken" })).rejects.toMatchObject({
      status: 502,
    });
  });
});
