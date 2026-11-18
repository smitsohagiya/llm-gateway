import { createHash } from "node:crypto";

import type { ChatMessage } from "../providers/types.js";

/** A small LRU cache with a time-to-live, built on Map's insertion order. */
export class ResponseCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    this.entries.delete(key);
    if (entry.expiresAt <= this.now()) {
      return undefined;
    }
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Requests that would produce the same answer share a key. */
export function cacheKey(
  model: string,
  messages: ChatMessage[],
  maxTokens: number | undefined,
): string {
  return createHash("sha256").update(JSON.stringify({ model, messages, maxTokens })).digest("hex");
}
