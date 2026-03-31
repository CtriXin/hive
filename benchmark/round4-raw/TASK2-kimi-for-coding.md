[Read: /Users/xin/auto-skills/CtriXin-repo/hive/src/logger.ts]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/src/config.ts]

$ ls -la /Users/xin/auto-skills/CtriXin-repo/hive/src 2>/dev/null || echo "src directory not found"

$ ls -la /Users/xin/auto-skills/CtriXin-repo/hive/

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/package.json]

$ mkdir -p /Users/xin/auto-skills/CtriXin-repo/hive/src


--- Writing: /Users/xin/auto-skills/CtriXin-repo/hive/src/log-aggregator.ts ---
export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: number;
  source: string;
  metadata?: Record<string, unknown>;
}

export interface Logger {
  log(entry: LogEntry): void;
  query(filter: { level?: LogEntry['level']; source?: string; since?: number }): LogEntry[];
}

interface Config {
  LOG_RETENTION_MS: number;
  AGGREGATE_INTERVAL_MS: number;
  MAX_ENTRIES_PER_AGGREGATE: number;
}

const DEFAULT_CONFIG: Config = {
  LOG_RETENTION_MS: 86400000,
  AGGREGATE_INTERVAL_MS: 60000,
  MAX_ENTRIES_PER_AGGREGATE: 1000,
};

export interface AggregateResult {
  period: { start: number; end: number };
  counts: Record<LogEntry['level'], number>;
  topSources: Array<{ source: string; count: number }>;
  errorSummary: string[];
}

export interface LogAggregator {
  aggregate(since: number, until: number): AggregateResult;
  startAutoAggregate(): void;
  stopAutoAggregate(): void;
  getHistory(count: number): AggregateResult[];
}

export class LogAggregatorImpl implements LogAggregator {
  private logger: Logger;
  private config: Config;
  private history: AggregateResult[] = [];
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(logger: Logger, configOverride?: Partial<Config>) {
    this.logger = logger;
    this.config = { ...DEFAULT_CONFIG, ...configOverride };
  }

  aggregate(since: number, until: number): AggregateResult {
    const entries = this.logger.query({ since });
    const filtered = entries.filter(e => e.timestamp <= until);

    const counts: Record<LogEntry['level'], number> = {
      debug: 0,
      info: 0,
      warn: 0,
      error: 0,
    };

    const sourceCounts = new Map<string, number>();
    const errorMessages = new Set<string>();

    for (const entry of filtered) {
      counts[entry.level]++;

      const current = sourceCounts.get(entry.source) || 0;
      sourceCounts.set(entry.source, current + 1);

      if (entry.level === 'error') {
        errorMessages.add(entry.message);
      }
    }

    const topSources = Array.from(sourceCounts.entries())
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const result: AggregateResult = {
      period: { start: since, end: until },
      counts,
      topSources,
      errorSummary: Array.from(errorMessages),
    };

    return result;
  }

  startAutoAggregate(): void {
    if (this.intervalId !== null) return;

    this.intervalId = setInterval(() => {
      const until = Date.now();
      const since = until - this.config.AGGREGATE_INTERVAL_MS;
      const result = this.aggregate(since, until);
      this.addToHistory(result);
    }, this.config.AGGREGATE_INTERVAL_MS);
  }

  stopAutoAggregate(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getHistory(count: number): AggregateResult[] {
    return this.history.slice(-count);
  }

  private addToHistory(result: AggregateResult): void {
    this.history.push(result);
    if (this.history.length > this.config.MAX_ENTRIES_PER_AGGREGATE) {
      this.history.shift();
    }
  }
}

--- End of /Users/xin/auto-skills/CtriXin-repo/hive/src/log-aggregator.ts ---



--- Writing: /Users/xin/auto-skills/CtriXin-repo/hive/src/log-aggregator.test.ts ---
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LogAggregatorImpl,
  Logger,
  LogEntry,
  AggregateResult,
} from './log-aggregator.js';

function createMockLogger(entries: LogEntry[] = []): Logger {
  return {
    log: vi.fn(),
    query: vi.fn(({ since }: { since?: number }) => {
      if (since === undefined) return entries;
      return entries.filter((e) => e.timestamp >= since);
    }),
  };
}

describe('LogAggregator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('should aggregate logs correctly for a given time range', () => {
    const now = Date.now();
    const entries: LogEntry[] = [
      {
        level: 'error',
        message: 'Connection failed',
        timestamp: now - 1000,
        source: 'api',
      },
      {
        level: 'error',
        message: 'Timeout',
        timestamp: now - 500,
        source: 'db',
      },
      {
        level: 'info',
        message: 'Request processed',
        timestamp: now - 200,
        source: 'api',
      },
      { level: 'warn', message: 'Slow query', timestamp: now - 100, source: 'db' },
      {
        level: 'debug',
        message: 'Debug info',
        timestamp: now - 50,
        source: 'cache',
      },
    ];

    const mockLogger = createMockLogger(entries);
    const aggregator = new LogAggregatorImpl(mockLogger);

    const result = aggregator.aggregate(now - 2000, now);

    expect(result.period).toEqual({ start: now - 2000, end: now });
    expect(result.counts).toEqual({
      debug: 1,
      info: 1,
      warn: 1,
      error: 2,
    });
    expect(result.topSources).toHaveLength(3);
    expect(result.topSources[0]).toEqual({ source: 'api', count: 2 });
    expect(result.errorSummary).toContain('Connection failed');
    expect(result.errorSummary).toContain('Timeout');
  });

  it('should handle auto-aggregation with start/stop', () => {
    const mockLogger = createMockLogger([]);
    const aggregator = new LogAggregatorImpl(mockLogger, {
      AGGREGATE_INTERVAL_MS: 1000,
    });

    expect(aggregator.getHistory(10)).toHaveLength(0);

    aggregator.startAutoAggregate();

    vi.advanceTimersByTime(1000);
    expect(aggregator.getHistory(10)).toHaveLength(1);

    vi.advanceTimersByTime(2000);
    expect(aggregator.getHistory(10)).toHaveLength(3);

    aggregator.stopAutoAggregate();

    vi.advanceTimersByTime(1000);
    expect(aggregator.getHistory(10)).toHaveLength(3);
  });

  it('should return only the most recent N history entries', () => {
    const now = Date.now();
    const entries: LogEntry[] = [
      {
        level: 'info',
        message: 'Old entry',
        timestamp: now - 5000,
        source: 'service-a',
      },
      {
        level: 'info',
        message: 'Middle entry',
        timestamp: now - 3000,
        source: 'service-b',
      },
      {
        level: 'info',
        message: 'Recent entry',
        timestamp: now - 1000,
        source: 'service-c',
      },
    ];

    const mockLogger = createMockLogger(entries);
    const aggregator = new LogAggregatorImpl(mockLogger);

    aggregator.aggregate(now - 6000, now - 4000);
    aggregator.aggregate(now - 4000, now - 2000);
    aggregator.aggregate(now - 2000, now);

    const history2 = aggregator.getHistory(2);
    expect(history2).toHaveLength(2);
    expect(history2[0].period.start).toBe(now - 4000);
    expect(history2[1].period.start).toBe(now - 2000);

    const history5 = aggregator.getHistory(5);
    expect(history5).toHaveLength(3);
  });
});

--- End of /Users/xin/auto-skills/CtriXin-repo/hive/src/log-aggregator.test.ts ---


$ npm test -- src/log-aggregator.test.ts

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/vitest.config.ts]

$ ls -la /Users/xin/auto-skills/CtriXin-repo/hive/tests/

$ mv /Users/xin/auto-skills/CtriXin-repo/hive/src/log-aggregator.test.ts /Users/xin/auto-skills/CtriXin-repo/hive/tests/log-aggregator.test.ts

[Edit: /Users/xin/auto-skills/CtriXin-repo/hive/tests/log-aggregator.test.ts]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/tests/log-aggregator.test.ts]

[Edit: /Users/xin/auto-skills/CtriXin-repo/hive/tests/log-aggregator.test.ts]

$ npm test -- log-aggregator.test.ts

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/tests/log-aggregator.test.ts]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/src/log-aggregator.ts]

[Edit: /Users/xin/auto-skills/CtriXin-repo/hive/tests/log-aggregator.test.ts]

$ npm test -- log-aggregator.test.ts