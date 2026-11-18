# ADR-0001: Make the OpenAI chat completions API the contract

- Status: accepted
- Date: 2026-11-19

## Context

Applications already use OpenAI's SDKs, LangChain, LlamaIndex and similar clients. A gateway with its own API would force every one of them to change before it could benefit from routing, budgets or fallbacks.

## Decision

Expose `/v1/chat/completions` and `/v1/models` in OpenAI's request, response, streaming (SSE) and error formats. Clients point their SDK's `base_url` at the gateway and use a route alias such as `fast` as the model name. Adapters translate to Anthropic's Messages API and Gemini's `generateContent`, and Ollama is reached through its OpenAI-compatible endpoint.

## Consequences

- Any OpenAI-compatible client works without code changes. Switching models is a config change, not a deploy of every app.
- Features without a common equivalent (tool calling formats, images) are out of scope for v0.1, and the adapters carry text only.
- The gateway adds `x-gateway-target`, `x-gateway-attempts` and `x-cache` headers, so callers can see what happened without breaking the format.
