# llm-gateway

[![CI](https://github.com/smitsohagiya/llm-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/smitsohagiya/llm-gateway/actions/workflows/ci.yml)

One OpenAI-compatible endpoint in front of OpenAI, Anthropic, Gemini and local models (Ollama). It adds alias routing with fallbacks, retries and timeouts, a circuit breaker, per-tenant token budgets, cost tracking, a response cache and Prometheus metrics. Built with TypeScript and Fastify, and ready to deploy to Kubernetes.

## Why

Every team that ships LLM features ends up writing the same plumbing: switch models without touching app code, survive a provider outage, stop one team from spending the month's budget in a day, and see what each feature costs. On the healthcare AI product I lead at work, this layer routes cheap models to extraction and stronger ones to scoring, with token budgets per facility. This repo is a clean, open version of that design.

## How it works

```mermaid
flowchart LR
    client[Any OpenAI SDK] --> auth[API key to tenant]
    auth --> budget[Budget check]
    budget --> cache{Cached?}
    cache -->|hit| reply[OpenAI-format response]
    cache -->|miss| targets[Alias to target list]
    targets --> call[Provider call with timeout]
    call -->|429, 5xx, network error| next[Retry, then next target]
    next --> call
    call -->|ok| record[Tokens, cost, metrics]
    record --> reply
```

- **OpenAI-compatible** ([ADR-0001](docs/decisions/ADR-0001-openai-compatible-api.md)): point any OpenAI SDK's `base_url` at the gateway and ask for an alias such as `fast`.
- **Routing and fallbacks:** each alias maps to an ordered list of `provider:model` targets. Retryable errors (429, 5xx, network, timeout) are retried with exponential backoff, then the next target is tried. Errors like 400 skip the retry.
- **Circuit breaker:** after repeated failures a target is skipped for a cooldown, then a single request checks whether it has recovered.
- **Streaming:** SSE in OpenAI's chunk format for every provider. Fallback happens only before the first token, so an answer is never stitched from two models ([ADR-0002](docs/decisions/ADR-0002-stream-fallback-before-first-token.md)).
- **Budgets and cost:** daily token budgets per tenant (429 when spent) and cost from per-million-token prices, visible at `/v1/usage` and in metrics.
- **Cache:** exact-match LRU cache with a TTL, used only for `temperature: 0` requests.
- **Metrics:** `gateway_requests_total`, `gateway_request_duration_seconds`, `gateway_tokens_total`, `gateway_cost_usd_total`, `gateway_cache_hits_total` and `gateway_fallbacks_total`.

## Quickstart (no API keys needed)

```bash
pnpm install
pnpm dev        # loads config/gateway.example.json
```

```bash
curl localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer demo-key" -H "content-type: application/json" \
  -d '{"model": "demo", "messages": [{"role": "user", "content": "hello"}]}'
```

The `demo` route's first target (`mock:flaky`) always fails, so you can watch the retry and the fallback. This is real output from the Docker image:

```console
$ curl -s -D - localhost:3000/v1/chat/completions -H "Authorization: Bearer demo-key" \
    -H "content-type: application/json" \
    -d '{"model":"demo","temperature":0,"messages":[{"role":"user","content":"Summarise our refund policy"}]}'
x-gateway-target: mock:echo
x-gateway-attempts: 3        # mock:flaky failed twice (1 retry), then the fallback answered
x-cache: miss
{"object":"chat.completion","model":"demo","choices":[{"index":0,"message":{"role":"assistant",
 "content":"Echo: Summarise our refund policy"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,...}}

$ # the same request again
x-gateway-attempts: 0
x-cache: hit

$ curl -s localhost:3000/metrics | grep ^gateway_
gateway_requests_total{route="demo",target="mock:flaky",status="error"} 3
gateway_requests_total{route="demo",target="mock:echo",status="ok"} 2
gateway_cache_hits_total{route="demo"} 1
gateway_fallbacks_total{route="demo",from="mock:flaky"} 2
```

With real providers, set any of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` or `OLLAMA_BASE_URL` (for example `http://localhost:11434/v1`), then use the `fast`, `smart` or `local` routes. From Python:

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3000/v1", api_key="demo-key")
reply = client.chat.completions.create(model="local", messages=[{"role": "user", "content": "hi"}])
```

## Configuration

`config/gateway.example.json` (set `GATEWAY_CONFIG` to use another file):

| Key                       | Meaning                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `tenants`                 | Name, API key and daily token budget. Use `"env:NAME"` for keys, so secrets stay out of the file.                               |
| `routes`                  | Alias to an ordered list of `provider:model` targets.                                                                           |
| `prices`                  | USD per million input and output tokens per target. The example prices are illustrative; check your provider's current pricing. |
| `timeoutMs`, `retries`    | Per attempt.                                                                                                                    |
| `cache`, `circuitBreaker` | TTL and size, and failure threshold and cooldown.                                                                               |

## Endpoints

| Method | Path                   |                                                      |
| ------ | ---------------------- | ---------------------------------------------------- |
| POST   | `/v1/chat/completions` | JSON, or SSE with `"stream": true`                   |
| GET    | `/v1/models`           | Route aliases                                        |
| GET    | `/v1/usage`            | The caller's tokens, remaining budget and cost today |
| GET    | `/metrics`             | Prometheus                                           |
| GET    | `/health`              | Liveness and readiness                               |

## Deploy

```bash
docker build -t llm-gateway .
kubectl create secret generic llm-gateway-secrets --from-literal=OPENAI_API_KEY=...   # see deploy/k8s/secret.example.yaml
kubectl apply -k deploy/k8s
```

The manifests run 2 replicas with probes, resource limits, a non-root user and a read-only filesystem, plus an HPA and Prometheus scrape annotations.

## Limitations

- Budgets, the cache and circuit state live in memory per replica ([ADR-0003](docs/decisions/ADR-0003-in-memory-state-first.md)). With N replicas a tenant could use up to N times its budget. A Redis store is the next step.
- v0.1 handles text chat only: no tool calls or images yet.
- Prompt and response text is never logged; only metadata is.

## What I'd do next

- Redis-backed budgets with an atomic per-day counter, and a shared cache.
- OpenTelemetry traces across the gateway and the providers.
- A semantic cache for near-duplicate prompts, measured against the exact-match one.

## License

MIT
