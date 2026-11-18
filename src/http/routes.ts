import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { Tenant } from "../gateway/budget.js";
import { GatewayError } from "../gateway/errors.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Metrics } from "../gateway/metrics.js";
import type { BudgetTracker } from "../gateway/budget.js";
import type { StreamEvent } from "../providers/types.js";

const ChatBody = z.object({
  model: z.string().min(1),
  messages: z
    .array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() }))
    .min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
});

export interface RouteDeps {
  gateway: Gateway;
  budget: BudgetTracker;
  metrics: Metrics;
  tenantsByKey: Map<string, Tenant>;
}

function authenticate(request: FastifyRequest, tenantsByKey: Map<string, Tenant>): Tenant {
  const header = request.headers.authorization ?? "";
  const tenant = tenantsByKey.get(header.replace(/^Bearer\s+/i, ""));
  if (!tenant) {
    throw new GatewayError("missing or invalid API key", 401, "invalid_api_key");
  }
  return tenant;
}

function chunk(
  id: string,
  model: string,
  delta: Record<string, string>,
  extra: Record<string, unknown> = {},
): string {
  const body = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: extra.finish_reason ?? null }],
    ...(extra.usage ? { usage: extra.usage } : {}),
  };
  return `data: ${JSON.stringify(body)}\n\n`;
}

async function* toSse(
  id: string,
  model: string,
  events: AsyncIterable<StreamEvent>,
): AsyncGenerator<string> {
  for await (const event of events) {
    if (event.type === "delta") {
      yield chunk(id, model, { content: event.text });
    } else {
      yield chunk(
        id,
        model,
        {},
        {
          finish_reason: event.finishReason,
          usage: {
            prompt_tokens: event.usage.promptTokens,
            completion_tokens: event.usage.completionTokens,
            total_tokens: event.usage.promptTokens + event.usage.completionTokens,
          },
        },
      );
    }
  }
  yield "data: [DONE]\n\n";
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { gateway, budget, metrics, tenantsByKey } = deps;

  app.get("/health", () => ({ status: "ok" }));

  app.get("/metrics", async (_request, reply) => {
    return reply
      .header("content-type", metrics.registry.contentType)
      .send(await metrics.registry.metrics());
  });

  app.get("/v1/models", (request) => {
    authenticate(request, tenantsByKey);
    return {
      object: "list",
      data: gateway.models().map((id) => ({ id, object: "model", owned_by: "llm-gateway" })),
    };
  });

  app.get("/v1/usage", (request) => budget.snapshot(authenticate(request, tenantsByKey)));

  app.post("/v1/chat/completions", async (request, reply) => {
    const tenant = authenticate(request, tenantsByKey);
    const body = ChatBody.parse(request.body);
    const chatRequest = {
      model: body.model,
      messages: body.messages,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
    };
    const id = `chatcmpl-${randomUUID()}`;
    const abort = new AbortController();
    request.raw.on("close", () => {
      if (!reply.raw.writableEnded) {
        abort.abort();
      }
    });

    if (body.stream) {
      const started = await gateway.stream(tenant, chatRequest, abort.signal);
      return reply
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .header("x-gateway-target", started.target)
        .send(Readable.from(toSse(id, body.model, started.events)));
    }

    const completion = await gateway.complete(tenant, chatRequest, abort.signal);
    const { result } = completion;
    return reply
      .header("x-gateway-target", completion.target)
      .header("x-gateway-attempts", String(completion.attempts))
      .header("x-cache", completion.cached ? "hit" : "miss")
      .send({
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: result.content },
            finish_reason: result.finishReason,
          },
        ],
        usage: {
          prompt_tokens: result.usage.promptTokens,
          completion_tokens: result.usage.completionTokens,
          total_tokens: result.usage.promptTokens + result.usage.completionTokens,
        },
      });
  });
}
