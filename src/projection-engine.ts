// Projection Engine - Event-driven state projection system
// Worker B implementation based on Worker A's EventStore interface

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
