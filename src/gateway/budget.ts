import type { Usage } from "../providers/types.js";
import { GatewayError } from "./errors.js";

export interface Tenant {
  name: string;
  dailyTokenBudget: number;
}

export interface UsageSnapshot {
  tenant: string;
  day: string;
  tokensUsed: number;
  dailyTokenBudget: number;
  tokensRemaining: number;
  costUsd: number;
}

type Prices = Record<string, { input: number; output: number }>;

/** Cost of a call in USD, from per-million-token prices. Unknown targets cost 0. */
export function costUsd(prices: Prices, target: string, usage: Usage): number {
  const price = prices[target];
  if (!price) {
    return 0;
  }
  return (usage.promptTokens * price.input + usage.completionTokens * price.output) / 1_000_000;
}

/**
 * Tracks each tenant's tokens and cost per UTC day and refuses requests once the budget is
 * spent. State lives in memory, so each replica tracks its own share; a shared store such as
 * Redis is the next step for multi-replica deployments.
 */
export class BudgetTracker {
  private readonly usage = new Map<string, { day: string; tokens: number; costUsd: number }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  assertWithin(tenant: Tenant): void {
    const used = this.current(tenant.name).tokens;
    if (used >= tenant.dailyTokenBudget) {
      throw new GatewayError(
        `daily token budget of ${String(tenant.dailyTokenBudget)} is used up for ${tenant.name}`,
        429,
        "budget_exceeded",
      );
    }
  }

  record(tenant: Tenant, usage: Usage, cost: number): void {
    const entry = this.current(tenant.name);
    entry.tokens += usage.promptTokens + usage.completionTokens;
    entry.costUsd += cost;
  }

  snapshot(tenant: Tenant): UsageSnapshot {
    const entry = this.current(tenant.name);
    return {
      tenant: tenant.name,
      day: entry.day,
      tokensUsed: entry.tokens,
      dailyTokenBudget: tenant.dailyTokenBudget,
      tokensRemaining: Math.max(tenant.dailyTokenBudget - entry.tokens, 0),
      costUsd: Number(entry.costUsd.toFixed(6)),
    };
  }

  private current(tenant: string): { day: string; tokens: number; costUsd: number } {
    const day = this.now().toISOString().slice(0, 10);
    let entry = this.usage.get(tenant);
    if (entry?.day !== day) {
      entry = { day, tokens: 0, costUsd: 0 };
      this.usage.set(tenant, entry);
    }
    return entry;
  }
}
