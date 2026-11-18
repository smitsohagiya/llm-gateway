import { readFileSync } from "node:fs";

import { z } from "zod";

const Target = z.string().regex(/^[a-z]+:.+$/, 'targets look like "provider:model"');

export const GatewayConfigSchema = z.object({
  tenants: z
    .array(
      z.object({
        name: z.string().min(1),
        /** A literal key for local demos, or "env:NAME" to read it from the environment. */
        apiKey: z.string().min(1),
        dailyTokenBudget: z.number().int().positive(),
      }),
    )
    .min(1),
  /** Model aliases clients can ask for, each mapped to targets tried in order. */
  routes: z.record(z.string(), z.array(Target).min(1)),
  /** USD per million tokens, keyed by target. Targets without a price cost 0. */
  prices: z
    .record(z.string(), z.object({ input: z.number().min(0), output: z.number().min(0) }))
    .default({}),
  timeoutMs: z.number().int().positive().default(30_000),
  retries: z.number().int().min(0).max(5).default(1),
  cache: z
    .object({ ttlSeconds: z.number().int().positive(), maxEntries: z.number().int().positive() })
    .default({ ttlSeconds: 300, maxEntries: 1_000 }),
  circuitBreaker: z
    .object({
      failureThreshold: z.number().int().positive(),
      cooldownMs: z.number().int().positive(),
    })
    .default({ failureThreshold: 3, cooldownMs: 30_000 }),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

/** Replace "env:NAME" values with the variable's value, so secrets stay out of config files. */
export function resolveSecret(value: string, env: NodeJS.ProcessEnv): string {
  if (!value.startsWith("env:")) {
    return value;
  }
  const name = value.slice(4);
  const resolved = env[name];
  if (!resolved) {
    throw new Error(`environment variable ${name} is not set`);
  }
  return resolved;
}

export function parseGatewayConfig(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  const parsed = GatewayConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid gateway config: ${parsed.error.message}`);
  }
  return {
    ...parsed.data,
    tenants: parsed.data.tenants.map((tenant) => ({
      ...tenant,
      apiKey: resolveSecret(tenant.apiKey, env),
    })),
  };
}

export function loadGatewayConfig(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  return parseGatewayConfig(JSON.parse(readFileSync(path, "utf8")) as unknown, env);
}
