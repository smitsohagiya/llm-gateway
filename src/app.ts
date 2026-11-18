import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

import type { Env } from "./config/env.js";
import type { GatewayConfig } from "./config/gateway-config.js";
import { BudgetTracker, type Tenant } from "./gateway/budget.js";
import { ResponseCache } from "./gateway/cache.js";
import { CircuitBreaker } from "./gateway/circuit-breaker.js";
import { GatewayError } from "./gateway/errors.js";
import { Gateway } from "./gateway/gateway.js";
import { createMetrics } from "./gateway/metrics.js";
import { registerRoutes } from "./http/routes.js";
import { createProviders } from "./providers/index.js";
import type { Provider } from "./providers/types.js";

export interface AppOptions {
  env: Env;
  config: GatewayConfig;
  /** Override the providers, e.g. with fakes in tests. Defaults to the ones in the environment. */
  providers?: Map<string, Provider>;
  sleep?: (ms: number) => Promise<void>;
}

/** Build the HTTP app without starting it, so tests can call it in memory. */
export function buildApp(options: AppOptions): FastifyInstance {
  const { env, config } = options;
  const app = Fastify({ logger: { level: env.LOG_LEVEL }, bodyLimit: 1_048_576 });
  const metrics = createMetrics();
  const budget = new BudgetTracker();
  const gateway = new Gateway({
    config,
    providers: options.providers ?? createProviders(env),
    cache: new ResponseCache(config.cache.maxEntries, config.cache.ttlSeconds * 1000),
    budget,
    breaker: new CircuitBreaker(
      config.circuitBreaker.failureThreshold,
      config.circuitBreaker.cooldownMs,
    ),
    metrics,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
  const tenantsByKey = new Map<string, Tenant>(
    config.tenants.map((t) => [t.apiKey, { name: t.name, dailyTokenBudget: t.dailyTokenBudget }]),
  );

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof GatewayError) {
      return reply.status(error.status).send(error.toBody());
    }
    if (error instanceof ZodError) {
      const invalid = new GatewayError(
        `invalid request: ${error.message}`,
        400,
        "invalid_request_error",
      );
      return reply.status(400).send(invalid.toBody());
    }
    app.log.error(error, "unhandled error");
    const internal = new GatewayError("internal error", 500, "internal_error");
    return reply.status(500).send(internal.toBody());
  });

  registerRoutes(app, { gateway, budget, metrics, tenantsByKey });
  return app;
}
