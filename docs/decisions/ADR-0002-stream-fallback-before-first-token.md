# ADR-0002: Streams fall back only before the first token

- Status: accepted
- Date: 2026-11-19

## Context

For a normal request, the gateway can try the next target whenever one fails. A stream is different: once the client has received tokens from one model, switching to another model mid-answer would produce a reply stitched together from two sources.

## Decision

`Gateway.stream` waits for the first event from a target before it returns. If the call fails before that, the gateway moves to the next target. Once the first event has arrived, the stream is committed to that target, and the HTTP response headers (including `x-gateway-target`) are only sent after this point. Usage and cost are recorded when the final event arrives.

## Consequences

- Clients never see a mixed answer, and an upstream failure before the first token still gets a fallback and a proper status code.
- A failure in the middle of a stream ends that stream. The client sees the connection end without a `[DONE]` event and can retry.
