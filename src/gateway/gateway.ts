import type { GatewayConfig } from "../config/gateway-config.js";
import {
  asProviderError,
  type ChatMessage,
  type ChatResult,
  type Provider,
  type ProviderRequest,
  type StreamEvent,
} from "../providers/types.js";
import { costUsd, type BudgetTracker, type Tenant } from "./budget.js";
import { cacheKey, type ResponseCache } from "./cache.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import { GatewayError } from "./errors.js";
import type { Metrics } from "./metrics.js";

export interface ChatRequest {
  /** A route alias from the config, or a direct "provider:model" target. */
  model: string;
  messages: ChatMessage[];
  temperature?: number | undefined;
  maxTokens?: number | undefined;
}

export interface Completion {
  result: ChatResult;
  target: string;
  cached: boolean;
  attempts: number;
}

export interface StreamStart {
  target: string;
  events: AsyncGenerator<StreamEvent>;
}

export interface GatewayDeps {
  config: GatewayConfig;
  providers: Map<string, Provider>;
  cache: ResponseCache<{ result: ChatResult; target: string }>;
  budget: BudgetTracker;
  breaker: CircuitBreaker;
  metrics: Metrics;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Routes each request through its target chain with retries, fallbacks and bookkeeping. */
export class Gateway {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: GatewayDeps) {
    this.sleep = deps.sleep ?? wait;
  }

  /** Aliases from the config plus the providers that are configured. */
  models(): string[] {
    return Object.keys(this.deps.config.routes);
  }

  targets(model: string): string[] {
    const route = this.deps.config.routes[model];
    if (route) {
      return route;
    }
    if (/^[a-z]+:.+$/.test(model)) {
      return [model];
    }
    throw new GatewayError(
      `unknown model "${model}"; use a route alias or provider:model`,
      400,
      "unknown_model",
    );
  }

  async complete(tenant: Tenant, request: ChatRequest, signal?: AbortSignal): Promise<Completion> {
    const route = this.routeLabel(request.model);
    const targets = this.targets(request.model);
    this.deps.budget.assertWithin(tenant);

    const key =
      request.temperature === 0
        ? cacheKey(request.model, request.messages, request.maxTokens)
        : undefined;
    const hit = key ? this.deps.cache.get(key) : undefined;
    if (hit) {
      this.deps.metrics.cacheHits.inc({ route });
      return { ...hit, cached: true, attempts: 0 };
    }

    let attempts = 0;
    const failures: string[] = [];
    for (const target of targets) {
      const provider = this.resolve(target, failures);
      if (!provider) {
        continue;
      }
      const providerRequest = this.providerRequest(target, request);
      for (let retry = 0; retry <= this.deps.config.retries; retry++) {
        attempts += 1;
        const started = performance.now();
        try {
          const result = await provider.chat(providerRequest, this.signal(signal));
          this.succeeded(tenant, route, target, result.usage, started);
          if (key) {
            this.deps.cache.set(key, { result, target });
          }
          return { result, target, cached: false, attempts };
        } catch (error) {
          const failure = asProviderError(provider.name, error);
          this.deps.metrics.requests.inc({ route, target, status: "error" });
          failures.push(`${target}: ${failure.message}`);
          if (!failure.retryable || retry === this.deps.config.retries) {
            break;
          }
          await this.sleep(100 * 2 ** retry);
        }
      }
      this.failed(route, target);
    }
    throw new GatewayError(
      `all targets failed: ${failures.join(" | ")}`,
      502,
      "upstream_unavailable",
    );
  }

  /**
   * Start a stream. Fallback is only possible until the first event arrives: after that the
   * client has already received tokens from this target.
   */
  async stream(tenant: Tenant, request: ChatRequest, signal?: AbortSignal): Promise<StreamStart> {
    const route = this.routeLabel(request.model);
    const targets = this.targets(request.model);
    this.deps.budget.assertWithin(tenant);

    const failures: string[] = [];
    for (const target of targets) {
      const provider = this.resolve(target, failures);
      if (!provider) {
        continue;
      }
      const started = performance.now();
      const events = provider.stream(this.providerRequest(target, request), this.signal(signal));
      const iterator = events[Symbol.asyncIterator]();
      try {
        const first = await iterator.next();
        return { target, events: this.track(tenant, route, target, started, first, iterator) };
      } catch (error) {
        const failure = asProviderError(provider.name, error);
        this.deps.metrics.requests.inc({ route, target, status: "error" });
        failures.push(`${target}: ${failure.message}`);
        this.failed(route, target);
      }
    }
    throw new GatewayError(
      `all targets failed: ${failures.join(" | ")}`,
      502,
      "upstream_unavailable",
    );
  }

  private async *track(
    tenant: Tenant,
    route: string,
    target: string,
    started: number,
    first: IteratorResult<StreamEvent>,
    rest: AsyncIterator<StreamEvent>,
  ): AsyncGenerator<StreamEvent> {
    let current = first;
    while (!current.done) {
      const event = current.value;
      if (event.type === "done") {
        this.succeeded(tenant, route, target, event.usage, started);
      }
      yield event;
      current = await rest.next();
    }
  }

  private resolve(target: string, failures: string[]): Provider | undefined {
    if (!this.deps.breaker.allows(target)) {
      failures.push(`${target}: circuit open`);
      return undefined;
    }
    const provider = this.deps.providers.get(target.slice(0, target.indexOf(":")));
    if (!provider) {
      failures.push(`${target}: provider not configured`);
    }
    return provider;
  }

  private providerRequest(target: string, request: ChatRequest): ProviderRequest {
    return {
      model: target.slice(target.indexOf(":") + 1),
      messages: request.messages,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
    };
  }

  private signal(client: AbortSignal | undefined): AbortSignal {
    const timeout = AbortSignal.timeout(this.deps.config.timeoutMs);
    return client ? AbortSignal.any([timeout, client]) : timeout;
  }

  private routeLabel(model: string): string {
    return model in this.deps.config.routes ? model : "direct";
  }

  private succeeded(
    tenant: Tenant,
    route: string,
    target: string,
    usage: { promptTokens: number; completionTokens: number },
    started: number,
  ): void {
    const { metrics, breaker, budget, config } = this.deps;
    const cost = costUsd(config.prices, target, usage);
    breaker.recordSuccess(target);
    budget.record(tenant, usage, cost);
    metrics.requests.inc({ route, target, status: "ok" });
    metrics.latency.observe({ route, target }, (performance.now() - started) / 1000);
    metrics.tokens.inc({ tenant: tenant.name, target, kind: "prompt" }, usage.promptTokens);
    metrics.tokens.inc({ tenant: tenant.name, target, kind: "completion" }, usage.completionTokens);
    metrics.cost.inc({ tenant: tenant.name, target }, cost);
  }

  private failed(route: string, target: string): void {
    this.deps.breaker.recordFailure(target);
    this.deps.metrics.fallbacks.inc({ route, from: target });
  }
}
