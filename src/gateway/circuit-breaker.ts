/**
 * Stops sending traffic to a target after repeated failures, then lets one request through
 * after a cooldown to check whether it has recovered.
 */
export class CircuitBreaker {
  private readonly state = new Map<string, { failures: number; openUntil: number }>();

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  allows(target: string): boolean {
    const entry = this.state.get(target);
    return entry === undefined || entry.openUntil <= this.now();
  }

  recordSuccess(target: string): void {
    this.state.delete(target);
  }

  recordFailure(target: string): void {
    const entry = this.state.get(target) ?? { failures: 0, openUntil: 0 };
    entry.failures += 1;
    if (entry.failures >= this.failureThreshold) {
      entry.openUntil = this.now() + this.cooldownMs;
    }
    this.state.set(target, entry);
  }

  openTargets(): string[] {
    return [...this.state.entries()]
      .filter(([, entry]) => entry.openUntil > this.now())
      .map(([target]) => target);
  }
}
