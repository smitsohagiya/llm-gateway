import { Counter, Histogram, Registry } from "prom-client";

export interface Metrics {
  registry: Registry;
  requests: Counter<"route" | "target" | "status">;
  latency: Histogram<"route" | "target">;
  tokens: Counter<"tenant" | "target" | "kind">;
  cost: Counter<"tenant" | "target">;
  cacheHits: Counter<"route">;
  fallbacks: Counter<"route" | "from">;
}

/** Prometheus metrics. Route labels are config aliases (or "direct"), so cardinality stays bounded. */
export function createMetrics(registry: Registry = new Registry()): Metrics {
  const registers = [registry];
  return {
    registry,
    requests: new Counter({
      name: "gateway_requests_total",
      help: "Upstream attempts by route, target and status.",
      labelNames: ["route", "target", "status"],
      registers,
    }),
    latency: new Histogram({
      name: "gateway_request_duration_seconds",
      help: "Successful upstream call duration.",
      labelNames: ["route", "target"],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
      registers,
    }),
    tokens: new Counter({
      name: "gateway_tokens_total",
      help: "Tokens used, by tenant, target and kind (prompt or completion).",
      labelNames: ["tenant", "target", "kind"],
      registers,
    }),
    cost: new Counter({
      name: "gateway_cost_usd_total",
      help: "Estimated spend in USD, by tenant and target.",
      labelNames: ["tenant", "target"],
      registers,
    }),
    cacheHits: new Counter({
      name: "gateway_cache_hits_total",
      help: "Requests answered from the response cache.",
      labelNames: ["route"],
      registers,
    }),
    fallbacks: new Counter({
      name: "gateway_fallbacks_total",
      help: "Times a target failed and the next one was tried.",
      labelNames: ["route", "from"],
      registers,
    }),
  };
}
