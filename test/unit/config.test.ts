import { describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import { loadGatewayConfig, parseGatewayConfig } from "../../src/config/gateway-config.js";
import { ResponseCache } from "../../src/gateway/cache.js";
import { createProviders } from "../../src/providers/index.js";

describe("gateway config", () => {
  it("loads the example and reads secrets from the environment", () => {
    const config = loadGatewayConfig("config/gateway.example.json", {
      GATEWAY_KEY_TEAM_A: "team-secret",
    });
    expect(config.tenants.map((t) => t.apiKey)).toEqual(["demo-key", "team-secret"]);
    expect(config.routes.demo).toEqual(["mock:flaky", "mock:echo"]);
  });

  it("fails clearly when a referenced secret is missing", () => {
    expect(() => loadGatewayConfig("config/gateway.example.json", {})).toThrow(
      "GATEWAY_KEY_TEAM_A is not set",
    );
  });

  it("validates targets and fills defaults", () => {
    expect(() =>
      parseGatewayConfig({
        tenants: [{ name: "a", apiKey: "k", dailyTokenBudget: 1 }],
        routes: { x: ["nocolon"] },
      }),
    ).toThrow("Invalid gateway config");
    const config = parseGatewayConfig({
      tenants: [{ name: "a", apiKey: "k", dailyTokenBudget: 1 }],
      routes: { x: ["mock:echo"] },
    });
    expect(config.cache).toEqual({ ttlSeconds: 300, maxEntries: 1000 });
    expect(config.retries).toBe(1);
  });
});

describe("environment and providers", () => {
  it("only registers providers that have credentials", () => {
    expect([...createProviders(loadEnv({})).keys()]).toEqual(["mock"]);
    const all = createProviders(
      loadEnv({
        OPENAI_API_KEY: "o",
        ANTHROPIC_API_KEY: "a",
        GEMINI_API_KEY: "g",
        OLLAMA_BASE_URL: "http://localhost:11434/v1",
      }),
    );
    expect([...all.keys()]).toEqual(["mock", "openai", "anthropic", "gemini", "ollama"]);
  });

  it("rejects an invalid Ollama URL", () => {
    expect(() => loadEnv({ OLLAMA_BASE_URL: "not a url" })).toThrow(/Invalid environment/);
  });
});

describe("ResponseCache", () => {
  it("evicts the least recently used entry and expires old ones", () => {
    let now = 0;
    const cache = new ResponseCache<string>(2, 100, () => now);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.get("a");
    cache.set("c", "3");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("1");
    now = 500;
    expect(cache.get("c")).toBeUndefined();
    expect(cache.size).toBe(1);
  });
});
