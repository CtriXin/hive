# TASK3: Projection Engine 实现

> Model: glm-5.1 (routed from MiniMax-M1-pro)

## Implementation: `src/projection-engine.ts`

```typescript
// Projection Engine - Event-driven state projection system

export interface DomainEvent {
  id: string;
  aggregateId: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: number;
  version: number;
}

export interface EventStore {
  append(aggregateId: string, events: DomainEvent[]): void;
  getEvents(aggregateId: string, fromVersion?: number): DomainEvent[];
  getLatestVersion(aggregateId: string): number;
  getAllAggregateIds(): string[];
}

export interface ProjectionHandler<TState> {
  init: () => TState;
  handle: (state: TState, event: DomainEvent) => TState;
}

interface ProjectionEntry {
  handler: ProjectionHandler<unknown>;
  states: Map<string, unknown>;
  versions: Map<string, number>;
}

export interface ProjectionEngine {
  register<TState>(name: string, handler: ProjectionHandler<TState>): void;
  rebuild(name: string): void;
  processNewEvents(aggregateId: string, events: DomainEvent[]): void;
  getState<TState>(name: string, aggregateId: string): TState | undefined;
  getProcessedVersion(name: string, aggregateId: string): number;
}

export function createProjectionEngine(store: EventStore): ProjectionEngine {
  const projections = new Map<string, ProjectionEntry>();

  function getOrCreateEntry(name: string): ProjectionEntry {
    const entry = projections.get(name);
    if (entry) return entry;

    const newEntry: ProjectionEntry = {
      handler: null as unknown as ProjectionHandler<unknown>,
      states: new Map(),
      versions: new Map(),
    };
    projections.set(name, newEntry);
    return newEntry;
  }

  function applyEvents<TState>(
    handler: ProjectionHandler<TState>,
    state: TState,
    events: DomainEvent[],
  ): TState {
    return events.reduce((current, event) => handler.handle(current, event), state);
  }

  return {
    register<TState>(name: string, handler: ProjectionHandler<TState>): void {
      const entry = getOrCreateEntry(name);
      entry.handler = handler as ProjectionHandler<unknown>;
    },

    rebuild(name: string): void {
      const entry = projections.get(name);
      if (!entry || !entry.handler) {
        throw new Error(`Projection '${name}' not found`);
      }

      entry.states.clear();
      entry.versions.clear();

      const aggregateIds = store.getAllAggregateIds();

      for (const aggregateId of aggregateIds) {
        const events = store.getEvents(aggregateId);
        if (events.length === 0) continue;

        const state = applyEvents(entry.handler, entry.handler.init(), events);
        entry.states.set(aggregateId, state);
        entry.versions.set(aggregateId, events[events.length - 1].version);
      }
    },

    processNewEvents(aggregateId: string, events: DomainEvent[]): void {
      if (events.length === 0) return;

      for (const [, entry] of projections) {
        if (!entry.handler) continue;

        const currentVersion = entry.versions.get(aggregateId) ?? 0;
        const newEvents = events.filter((e) => e.version > currentVersion);

        if (newEvents.length === 0) continue;

        const currentState = entry.states.get(aggregateId) ?? entry.handler.init();
        const newState = applyEvents(entry.handler, currentState, newEvents);

        entry.states.set(aggregateId, newState);
        entry.versions.set(aggregateId, newEvents[newEvents.length - 1].version);
      }
    },

    getState<TState>(name: string, aggregateId: string): TState | undefined {
      const entry = projections.get(name);
      if (!entry) return undefined;
      return entry.states.get(aggregateId) as TState | undefined;
    },

    getProcessedVersion(name: string, aggregateId: string): number {
      const entry = projections.get(name);
      if (!entry) return 0;
      return entry.versions.get(aggregateId) ?? 0;
    },
  };
}
```

## Tests: `tests/projection-engine.test.ts`

```typescript
// Tests for ProjectionEngine
// Uses mock EventStore to avoid dependency on Worker A's implementation

import { describe, it, expect } from "vitest";
import {
  createProjectionEngine,
  DomainEvent,
  EventStore,
  ProjectionHandler,
} from "../src/projection-engine";

function createMockEventStore(): EventStore {
  const events = new Map<string, DomainEvent[]>();

  return {
    append(aggregateId: string, newEvents: DomainEvent[]): void {
      const existing = events.get(aggregateId) ?? [];
      events.set(aggregateId, [...existing, ...newEvents]);
    },

    getEvents(aggregateId: string, fromVersion?: number): DomainEvent[] {
      const all = events.get(aggregateId) ?? [];
      if (fromVersion === undefined) return all;
      return all.filter((e) => e.version >= fromVersion);
    },

    getLatestVersion(aggregateId: string): number {
      const all = events.get(aggregateId) ?? [];
      if (all.length === 0) return 0;
      return all[all.length - 1].version;
    },

    getAllAggregateIds(): string[] {
      return Array.from(events.keys());
    },
  };
}

describe("ProjectionEngine", () => {
  // Test 1: Basic projection (register + processNewEvents + getState)
  it("basic projection - register, process events, get state", () => {
    const store = createMockEventStore();
    const engine = createProjectionEngine(store);

    interface CounterState {
      count: number;
      events: string[];
    }

    const counterHandler: ProjectionHandler<CounterState> = {
      init: () => ({ count: 0, events: [] }),
      handle: (state, event) => ({
        count: state.count + 1,
        events: [...state.events, event.type],
      }),
    };

    engine.register<CounterState>("counter", counterHandler);

    const aggregateId = "agg-1";
    const events: DomainEvent[] = [
      { id: "e1", aggregateId, type: "Created", payload: {}, timestamp: 1, version: 1 },
      { id: "e2", aggregateId, type: "Updated", payload: {}, timestamp: 2, version: 2 },
    ];
    store.append(aggregateId, events);
    engine.processNewEvents(aggregateId, events);

    const state = engine.getState<CounterState>("counter", aggregateId);
    expect(state?.count).toBe(2);
    expect(state?.events).toEqual(["Created", "Updated"]);
  });

  // Test 2: Rebuild from scratch
  it("rebuild - reconstructs state from all historical events", () => {
    const store = createMockEventStore();
    const engine = createProjectionEngine(store);

    interface SumState {
      total: number;
    }

    const sumHandler: ProjectionHandler<SumState> = {
      init: () => ({ total: 0 }),
      handle: (state, event) => ({
        total: state.total + (event.payload.value as number || 0),
      }),
    };

    engine.register<SumState>("sum", sumHandler);

    const aggregateId = "agg-1";
    const events: DomainEvent[] = [
      { id: "e1", aggregateId, type: "Add", payload: { value: 10 }, timestamp: 1, version: 1 },
      { id: "e2", aggregateId, type: "Add", payload: { value: 20 }, timestamp: 2, version: 2 },
      { id: "e3", aggregateId, type: "Add", payload: { value: 30 }, timestamp: 3, version: 3 },
    ];
    store.append(aggregateId, events);

    engine.rebuild("sum");

    const state = engine.getState<SumState>("sum", aggregateId);
    expect(state?.total).toBe(60);
    expect(engine.getProcessedVersion("sum", aggregateId)).toBe(3);
  });

  // Test 3: Incremental updates (only process new events)
  it("incremental update - only processes new events", () => {
    const store = createMockEventStore();
    const engine = createProjectionEngine(store);

    interface LogState {
      entries: string[];
    }

    const logHandler: ProjectionHandler<LogState> = {
      init: () => ({ entries: [] }),
      handle: (state, event) => ({
        entries: [...state.entries, event.id],
      }),
    };

    engine.register<LogState>("log", logHandler);

    const aggregateId = "agg-1";

    const events1: DomainEvent[] = [
      { id: "e1", aggregateId, type: "A", payload: {}, timestamp: 1, version: 1 },
      { id: "e2", aggregateId, type: "B", payload: {}, timestamp: 2, version: 2 },
    ];
    store.append(aggregateId, events1);
    engine.processNewEvents(aggregateId, events1);

    expect(engine.getState<LogState>("log", aggregateId)?.entries).toEqual(["e1", "e2"]);
    expect(engine.getProcessedVersion("log", aggregateId)).toBe(2);

    const events2: DomainEvent[] = [
      { id: "e3", aggregateId, type: "C", payload: {}, timestamp: 3, version: 3 },
      { id: "e4", aggregateId, type: "D", payload: {}, timestamp: 4, version: 4 },
    ];
    store.append(aggregateId, events2);
    engine.processNewEvents(aggregateId, events2);

    expect(engine.getState<LogState>("log", aggregateId)?.entries).toEqual(["e1", "e2", "e3", "e4"]);
    expect(engine.getProcessedVersion("log", aggregateId)).toBe(4);
  });

  // Test 4: Multiple independent projections
  it("multiple projections - independent states", () => {
    const store = createMockEventStore();
    const engine = createProjectionEngine(store);

    interface CountState {
      count: number;
    }

    interface LastEventState {
      lastType: string;
    }

    const countHandler: ProjectionHandler<CountState> = {
      init: () => ({ count: 0 }),
      handle: (state) => ({ count: state.count + 1 }),
    };

    const lastEventHandler: ProjectionHandler<LastEventState> = {
      init: () => ({ lastType: "" }),
      handle: (_, event) => ({ lastType: event.type }),
    };

    engine.register<CountState>("count", countHandler);
    engine.register<LastEventState>("lastEvent", lastEventHandler);

    const aggregateId = "agg-1";
    const events: DomainEvent[] = [
      { id: "e1", aggregateId, type: "Created", payload: {}, timestamp: 1, version: 1 },
      { id: "e2", aggregateId, type: "Updated", payload: {}, timestamp: 2, version: 2 },
      { id: "e3", aggregateId, type: "Deleted", payload: {}, timestamp: 3, version: 3 },
    ];
    store.append(aggregateId, events);
    engine.processNewEvents(aggregateId, events);

    const countState = engine.getState<CountState>("count", aggregateId);
    expect(countState?.count).toBe(3);
    expect(engine.getProcessedVersion("count", aggregateId)).toBe(3);

    const lastState = engine.getState<LastEventState>("lastEvent", aggregateId);
    expect(lastState?.lastType).toBe("Deleted");
    expect(engine.getProcessedVersion("lastEvent", aggregateId)).toBe(3);

    const events2: DomainEvent[] = [
      { id: "e4", aggregateId, type: "Restored", payload: {}, timestamp: 4, version: 4 },
    ];
    store.append(aggregateId, events2);
    engine.processNewEvents(aggregateId, events2);

    expect(engine.getState<CountState>("count", aggregateId)?.count).toBe(4);
    expect(engine.getState<LastEventState>("lastEvent", aggregateId)?.lastType).toBe("Restored");
  });

  // Test 5: Multiple aggregates
  it("multiple aggregates - separate state per aggregate", () => {
    const store = createMockEventStore();
    const engine = createProjectionEngine(store);

    interface BalanceState {
      balance: number;
    }

    const balanceHandler: ProjectionHandler<BalanceState> = {
      init: () => ({ balance: 0 }),
      handle: (state, event) => ({
        balance: state.balance + (event.payload.amount as number || 0),
      }),
    };

    engine.register<BalanceState>("balance", balanceHandler);

    const events1: DomainEvent[] = [
      { id: "e1", aggregateId: "account-1", type: "Deposit", payload: { amount: 100 }, timestamp: 1, version: 1 },
      { id: "e2", aggregateId: "account-1", type: "Deposit", payload: { amount: 50 }, timestamp: 2, version: 2 },
    ];

    const events2: DomainEvent[] = [
      { id: "e3", aggregateId: "account-2", type: "Deposit", payload: { amount: 200 }, timestamp: 3, version: 1 },
    ];

    store.append("account-1", events1);
    store.append("account-2", events2);

    engine.processNewEvents("account-1", events1);
    engine.processNewEvents("account-2", events2);

    expect(engine.getState<BalanceState>("balance", "account-1")?.balance).toBe(150);
    expect(engine.getState<BalanceState>("balance", "account-2")?.balance).toBe(200);
    expect(engine.getProcessedVersion("balance", "account-1")).toBe(2);
    expect(engine.getProcessedVersion("balance", "account-2")).toBe(1);
  });

  // Test 6: Rebuild throws for unknown projection
  it("rebuild throws for unknown projection", () => {
    const store = createMockEventStore();
    const engine = createProjectionEngine(store);

    expect(() => engine.rebuild("unknown")).toThrow("Projection 'unknown' not found");
  });

  // Test 7: Get state returns undefined for unknown projection
  it("getState returns undefined for unknown projection", () => {
    const store = createMockEventStore();
    const engine = createProjectionEngine(store);

    const state = engine.getState("unknown", "agg-1");
    expect(state).toBeUndefined();
  });

  // Test 8: Get processed version returns 0 for unknown projection/aggregate
  it("getProcessedVersion returns 0 for unknown", () => {
    const store = createMockEventStore();
    const engine = createProjectionEngine(store);

    expect(engine.getProcessedVersion("unknown", "agg-1")).toBe(0);

    interface State { value: number; }
    engine.register<State>("test", { init: () => ({ value: 0 }), handle: (s) => s });
    expect(engine.getProcessedVersion("test", "unknown-agg")).toBe(0);
  });
});
```

## Test Results

```
 ✓ tests/projection-engine.test.ts (8 tests) 4ms
   ✓ basic projection - register, process events, get state
   ✓ rebuild - reconstructs state from all historical events
   ✓ incremental update - only processes new events
   ✓ multiple projections - independent states
   ✓ multiple aggregates - separate state per aggregate
   ✓ rebuild throws for unknown projection
   ✓ getState returns undefined for unknown projection
   ✓ getProcessedVersion returns 0 for unknown

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Duration  119ms
```

## Design Summary

| Method | Description |
|--------|-------------|
| `register<TState>(name, handler)` | Registers a named projection with `init()` and `handle()` functions |
| `rebuild(name)` | Clears all state and replays entire EventStore history for all aggregates |
| `processNewEvents(aggregateId, events)` | Incrementally applies only events with version > last processed version across all registered projections |
| `getState<TState>(name, aggregateId)` | Returns projected state for a given aggregate |
| `getProcessedVersion(name, aggregateId)` | Returns last processed event version number |

Key design choices:
- Projections are stored in a `Map<string, ProjectionEntry>` where each entry tracks handler, per-aggregate states, and per-aggregate versions
- `processNewEvents` fans out to **all** registered projections, filtering by version to skip already-processed events
- `rebuild` iterates `store.getAllAggregateIds()` and replays from scratch using `handler.init()` as the starting state
- Unknown projections return `undefined` for state and `0` for version; `rebuild` throws
