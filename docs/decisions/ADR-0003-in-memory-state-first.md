# ADR-0003: Keep budgets, cache and circuit state in memory for v0.1

- Status: accepted
- Date: 2026-11-19

## Context

Budgets, the response cache and circuit-breaker state all need storage. A shared store (Redis) is the right answer for several replicas, but it adds an operational dependency before the design has been proven.

## Decision

Keep all three in memory behind small classes (`BudgetTracker`, `ResponseCache`, `CircuitBreaker`) with narrow interfaces, so a Redis-backed version can replace them without touching the gateway logic.

## Consequences

- One container runs the whole thing, and the tests need no infrastructure.
- With N replicas, each one enforces the budget for its own traffic, so a tenant could spend up to N times its daily budget, and each replica has its own cache. The Kubernetes manifests run 2 replicas, so this limit is documented in the README.
- Moving the budget to Redis (an atomic `INCRBY` per tenant per day) is the first item in "What I'd do next".
