# Architecture

```mermaid
flowchart LR
    client[Any OpenAI SDK] --> auth[Auth: API key to tenant]
    auth --> budget[Daily token budget check]
    budget --> cache{temperature 0 and cached?}
    cache -->|hit| reply[OpenAI-format response]
    cache -->|miss| route[Resolve alias to targets]
    route --> target[Next target]
    target --> breaker{Circuit open?}
    breaker -->|yes| target
    breaker -->|no| call[Call provider with timeout]
    call -->|429, 5xx, network| retry[Retry with backoff, then fall back]
    retry --> target
    call -->|ok| record[Record tokens, cost, metrics]
    record --> reply
```

| Part             | File                             | Notes                                                                                                                                                              |
| ---------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP API         | `src/http/routes.ts`             | `/v1/chat/completions` (JSON or SSE), `/v1/models`, `/v1/usage`, `/metrics`, `/health`. Errors use OpenAI's error format.                                          |
| Gateway          | `src/gateway/gateway.ts`         | Resolves aliases, walks the target list, retries retryable errors, falls back, and records usage.                                                                  |
| Providers        | `src/providers/`                 | OpenAI (also used for Ollama), Anthropic and Gemini, plus a deterministic mock. Each one translates the common request into the vendor's API, including streaming. |
| Circuit breaker  | `src/gateway/circuit-breaker.ts` | Skips a target after repeated failures and lets one request through after the cooldown.                                                                            |
| Budgets and cost | `src/gateway/budget.ts`          | Tokens and USD per tenant per UTC day, using per-million-token prices from the config.                                                                             |
| Cache            | `src/gateway/cache.ts`           | LRU with TTL. Only requests with `temperature: 0` are cached, keyed by a hash of the model, messages and max tokens.                                               |
| Metrics          | `src/gateway/metrics.ts`         | Prometheus counters and a latency histogram. Route labels are config aliases, so label cardinality stays bounded.                                                  |

Request and response text is never logged. Only metadata (tenant, route, target, tokens, latency) is recorded.
