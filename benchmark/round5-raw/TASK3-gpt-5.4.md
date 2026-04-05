# TASK3: Projection Engine Implementation

## Overview

A lightweight Projection Engine built on top of the `EventStore` interface. It supports:
- Incremental event processing
- Full rebuild from the event store
- In-memory state caching per aggregate
- Version tracking for each projection

## Interfaces

```typescript
export interface DomainEvent {
  type: string;
  version: number;
  payload: Record<string, unknown>;
}

export interface EventStore {
  append(aggregateId: string, events: DomainEvent[]): void;
  getEvents(aggregateId: string, fromVersion?: number): DomainEvent[];
  getLatestVersion(aggregateId: string): number;
  getAllAggregateIds(): string[];
}

export interface ProjectionHandler<TState> {
  init: () => TState;
  apply: (state: TState, event: DomainEvent) => TState;
}

export interface ProjectionEngine {
  register<TState>(name: string, handler: ProjectionHandler<TState>): void;
  rebuild(name: string): void;
  processNewEvents(aggregateId: string, events: DomainEvent[]): void;
  getState<TState>(name: string, aggregateId: string): TState | undefined;
  getProcessedVersion(name: string, aggregateId: string): number;
}
```

## Implementation

```typescript
export class InMemoryEventStore implements EventStore {
  private aggregates = new Map<string, DomainEvent[]>();

  append(aggregateId: string, events: DomainEvent[]): void {
    const existing = this.aggregates.get(aggregateId) ?? [];
    this.aggregates.set(aggregateId, [...existing, ...events]);
  }

  getEvents(aggregateId: string, fromVersion = 0): DomainEvent[] {
    const all = this.aggregates.get(aggregateId) ?? [];
    if (fromVersion <= 0) return [...all];
    return all.filter((e) => e.version > fromVersion);
  }

  getLatestVersion(aggregateId: string): number {
    const all = this.aggregates.get(aggregateId) ?? [];
    if (all.length === 0) return 0;
    return all[all.length - 1].version;
  }

  getAllAggregateIds(): string[] {
    return Array.from(this.aggregates.keys());
  }
}

export class DefaultProjectionEngine implements ProjectionEngine {
  private handlers = new Map<string, ProjectionHandler<unknown>>();
  private states = new Map<string, Map<string, unknown>>(); // name -> aggregateId -> state
  private versions = new Map<string, Map<string, number>>(); // name -> aggregateId -> version

  constructor(private eventStore: EventStore) {}

  register<TState>(name: string, handler: ProjectionHandler<TState>): void {
    if (this.handlers.has(name)) {
      throw new Error(`Projection "${name}" is already registered.`);
    }
    this.handlers.set(name, handler as ProjectionHandler<unknown>);
    this.states.set(name, new Map());
    this.versions.set(name, new Map());
  }

  rebuild(name: string): void {
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new Error(`Projection "${name}" not found.`);
    }

    const stateMap = new Map<string, unknown>();
    const versionMap = new Map<string, number>();

    for (const aggregateId of this.eventStore.getAllAggregateIds()) {
      const events = this.eventStore.getEvents(aggregateId);
      let state = handler.init();
      let lastVersion = 0;

      for (const event of events) {
        state = handler.apply(state, event);
        lastVersion = event.version;
      }

      stateMap.set(aggregateId, state);
      versionMap.set(aggregateId, lastVersion);
    }

    this.states.set(name, stateMap);
    this.versions.set(name, versionMap);
  }

  processNewEvents(aggregateId: string, events: DomainEvent[]): void {
    for (const [name, handler] of this.handlers.entries()) {
      const stateMap = this.states.get(name)!;
      const versionMap = this.versions.get(name)!;
      const currentVersion = versionMap.get(aggregateId) ?? 0;
      const sorted = [...events].sort((a, b) => a.version - b.version);

      // Only apply events that haven't been processed yet
      let state = stateMap.get(aggregateId) ?? handler.init();
      let lastVersion = currentVersion;

      for (const event of sorted) {
        if (event.version > currentVersion) {
          state = handler.apply(state, event);
          lastVersion = event.version;
        }
      }

      stateMap.set(aggregateId, state);
      versionMap.set(aggregateId, lastVersion);
    }
  }

  getState<TState>(name: string, aggregateId: string): TState | undefined {
    return this.states.get(name)?.get(aggregateId) as TState | undefined;
  }

  getProcessedVersion(name: string, aggregateId: string): number {
    return this.versions.get(name)?.get(aggregateId) ?? 0;
  }
}
```

## Tests

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryEventStore, DefaultProjectionEngine } from "./projection-engine";

interface CounterState {
  count: number;
  history: string[];
}

describe("ProjectionEngine", () => {
  let eventStore: InMemoryEventStore;
  let engine: DefaultProjectionEngine;

  const counterHandler = {
    init: (): CounterState => ({ count: 0, history: [] }),
    apply: (state: CounterState, event: DomainEvent): CounterState => {
      if (event.type === "Incremented") {
        return {
          count: state.count + (event.payload.amount as number),
          history: [...state.history, `+${event.payload.amount}`],
        };
      }
      if (event.type === "Decremented") {
        return {
          count: state.count - (event.payload.amount as number),
          history: [...state.history, `-${event.payload.amount}`],
        };
      }
      return state;
    },
  };

  beforeEach(() => {
    eventStore = new InMemoryEventStore();
    engine = new DefaultProjectionEngine(eventStore);
    engine.register<CounterState>("counter", counterHandler);
  });

  it("should return undefined before any events are processed", () => {
    expect(engine.getState<CounterState>("counter", "agg-1")).toBeUndefined();
    expect(engine.getProcessedVersion("counter", "agg-1")).toBe(0);
  });

  it("should rebuild projection from full event store history", () => {
    eventStore.append("agg-1", [
      { type: "Incremented", version: 1, payload: { amount: 10 } },
      { type: "Incremented", version: 2, payload: { amount: 5 } },
      { type: "Decremented", version: 3, payload: { amount: 3 } },
    ]);

    engine.rebuild("counter");

    const state = engine.getState<CounterState>("counter", "agg-1")!;
    expect(state.count).toBe(12);
    expect(state.history).toEqual(["+10", "+5", "-3"]);
    expect(engine.getProcessedVersion("counter", "agg-1")).toBe(3);
  });

  it("should process new events incrementally", () => {
    eventStore.append("agg-1", [
      { type: "Incremented", version: 1, payload: { amount: 10 } },
      { type: "Incremented", version: 2, payload: { amount: 5 } },
    ]);

    engine.rebuild("counter");

    // Simulate new events being appended directly to the engine
    engine.processNewEvents("agg-1", [
      { type: "Decremented", version: 3, payload: { amount: 3 } },
    ]);

    const state = engine.getState<CounterState>("counter", "agg-1")!;
    expect(state.count).toBe(12);
    expect(state.history).toEqual(["+10", "+5", "-3"]);
    expect(engine.getProcessedVersion("counter", "agg-1")).toBe(3);
  });

  it("should ignore already processed events during incremental update", () => {
    eventStore.append("agg-1", [
      { type: "Incremented", version: 1, payload: { amount: 10 } },
    ]);

    engine.rebuild("counter");

    engine.processNewEvents("agg-1", [
      { type: "Incremented", version: 1, payload: { amount: 10 } }, // duplicate
      { type: "Incremented", version: 2, payload: { amount: 5 } },
    ]);

    const state = engine.getState<CounterState>("counter", "agg-1")!;
    expect(state.count).toBe(15);
    expect(engine.getProcessedVersion("counter", "agg-1")).toBe(2);
  });
});
```

## Design Notes

1. **Storage Abstraction**
   The engine never stores events itself. It delegates all persistence to the injected `EventStore`. Rebuild reads all aggregates via `getAllAggregateIds()` and replays their full history.

2. **Incremental Updates**
   `processNewEvents` only applies events whose `version` is greater than the locally tracked `processedVersion`. This guarantees idempotency when the same event batch is received multiple times.

3. **Isolation**
   Each projection is isolated by name. One `DefaultProjectionEngine` instance can host many projections, each with its own handler and state cache.

4. **Simplicity**
   State and version caches are plain `Map`s. For production use, these maps could be swapped out for external caches (Redis, SQLite, etc.) without changing the `ProjectionEngine` interface.
