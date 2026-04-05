// Tests for ProjectionEngine
// Uses mock EventStore to avoid dependency on Worker A's implementation

import { describe, it, expect } from "vitest";
import {
  createProjectionEngine,
  DomainEvent,
  EventStore,
  ProjectionHandler,
} from "../src/projection-engine";

// Mock EventStore implementation for testing
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

    // Append events to store first
    const aggregateId = "agg-1";
    const events: DomainEvent[] = [
      { id: "e1", aggregateId, type: "Created", payload: {}, timestamp: 1, version: 1 },
      { id: "e2", aggregateId, type: "Updated", payload: {}, timestamp: 2, version: 2 },
    ];
    store.append(aggregateId, events);

    // Process new events
    engine.processNewEvents(aggregateId, events);

    // Verify state
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

    // Add events to store before registering
    const aggregateId = "agg-1";
    const events: DomainEvent[] = [
      { id: "e1", aggregateId, type: "Add", payload: { value: 10 }, timestamp: 1, version: 1 },
      { id: "e2", aggregateId, type: "Add", payload: { value: 20 }, timestamp: 2, version: 2 },
      { id: "e3", aggregateId, type: "Add", payload: { value: 30 }, timestamp: 3, version: 3 },
    ];
    store.append(aggregateId, events);

    // Rebuild should process all events
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

    // First batch of events
    const events1: DomainEvent[] = [
      { id: "e1", aggregateId, type: "A", payload: {}, timestamp: 1, version: 1 },
      { id: "e2", aggregateId, type: "B", payload: {}, timestamp: 2, version: 2 },
    ];
    store.append(aggregateId, events1);
    engine.processNewEvents(aggregateId, events1);

    expect(engine.getState<LogState>("log", aggregateId)?.entries).toEqual(["e1", "e2"]);
    expect(engine.getProcessedVersion("log", aggregateId)).toBe(2);

    // Second batch of events (incremental)
    const events2: DomainEvent[] = [
      { id: "e3", aggregateId, type: "C", payload: {}, timestamp: 3, version: 3 },
      { id: "e4", aggregateId, type: "D", payload: {}, timestamp: 4, version: 4 },
    ];
    store.append(aggregateId, events2);
    engine.processNewEvents(aggregateId, events2);

    // Should have all 4 events, not re-processed first 2
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

    // Count projection should have 3
    const countState = engine.getState<CountState>("count", aggregateId);
    expect(countState?.count).toBe(3);
    expect(engine.getProcessedVersion("count", aggregateId)).toBe(3);

    // LastEvent projection should have "Deleted"
    const lastState = engine.getState<LastEventState>("lastEvent", aggregateId);
    expect(lastState?.lastType).toBe("Deleted");
    expect(engine.getProcessedVersion("lastEvent", aggregateId)).toBe(3);

    // Verify independence - process more events
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

    // Events for aggregate 1
    const events1: DomainEvent[] = [
      { id: "e1", aggregateId: "account-1", type: "Deposit", payload: { amount: 100 }, timestamp: 1, version: 1 },
      { id: "e2", aggregateId: "account-1", type: "Deposit", payload: { amount: 50 }, timestamp: 2, version: 2 },
    ];

    // Events for aggregate 2
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
