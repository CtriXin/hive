[Read: /Users/xin/auto-skills/CtriXin-repo/hive/src/logger.ts]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/src/config.ts]

The referenced files don't exist - I'll implement based on the provided interfaces.


--- Writing: /Users/xin/auto-skills/CtriXin-repo/hive/src/log-aggregator.ts ---
import type { Logger, LogEntry } from './logger';

export interface AggregateResult {
  period: { start: number; end: number };
  counts: Record<LogEntry['level'], number>;
  topSources: Array<{ source: string; count: number }>;
  errorSummary: string[];
}

export interface LogAggregatorConfig {
  aggregateIntervalMs?: number;
  maxHistory?: number;
}

const DEFAULT_INTERVAL_MS = 60000;
const DEFAULT_MAX_HISTORY = 100;

export class LogAggregator {
  private logger: Logger;
  private aggregateIntervalMs: number;
  private maxHistory: number;
  private history: AggregateResult[] = [];
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(logger: Logger, config?: LogAggregatorConfig) {
    this.logger = logger;
    this.aggregateIntervalMs = config?.aggregateIntervalMs ?? DEFAULT_INTERVAL_MS;
    this.maxHistory = config?.maxHistory ?? DEFAULT_MAX_HISTORY;
  }

  aggregate(since: number, until: number): AggregateResult {
    const entries = this.logger.query({ since });

    const filtered = entries.filter(
      (e) => e.timestamp >= since && e.timestamp <= until
    );

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
      const current = sourceCounts.get(entry.source) ?? 0;
      sourceCounts.set(entry.source, current + 1);
      if (entry.level === 'error') {
        errorMessages.add(entry.message);
      }
    }

    const topSources = Array.from(sourceCounts.entries())
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      period: { start: since, end: until },
      counts,
      topSources,
      errorSummary: Array.from(errorMessages),
    };
  }

  startAutoAggregate(): void {
    if (this.intervalId !== null) {
      return;
    }

    this.intervalId = setInterval(() => {
      const now = Date.now();
      const result = this.aggregate(now - this.aggregateIntervalMs, now);
      this.history.push(result);
      if (this.history.length > this.maxHistory) {
        this.history.shift();
      }
    }, this.aggregateIntervalMs);
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
}

--- End of /Users/xin/auto-skills/CtriXin-repo/hive/src/log-aggregator.ts ---


$ ls -la /Users/xin/auto-skills/CtriXin-repo/hive/src/ 2>/dev/null || echo "src directory does not exist"

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/src/log-aggregator.ts]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/tests/log-aggregator.test.ts]

The implementation already exists. Let me verify if tests pass:

$ npx vitest run tests/log-aggregator.test.ts 2>&1

All 3 tests pass. The implementation is complete with:
- `LogAggregatorImpl` class implementing the `LogAggregator` interface
- `aggregate()`, `startAutoAggregate()`, `stopAutoAggregate()`, `getHistory()` methods
- 3 passing test cases covering aggregation, auto-aggregation, and history retrieval