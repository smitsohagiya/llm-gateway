# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- OpenAI-compatible `/v1/chat/completions` with JSON and SSE streaming, plus `/v1/models`, `/v1/usage`, `/metrics` and `/health`.
- Provider adapters for OpenAI (also Ollama), Anthropic and Gemini, and a deterministic mock provider.
- Alias routing with ordered fallbacks, retries with backoff, per-attempt timeouts and a circuit breaker.
- Per-tenant daily token budgets, cost tracking and an exact-match response cache.
- Prometheus metrics, a Dockerfile and Kubernetes manifests.
