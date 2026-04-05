import { describe, it, expect } from 'vitest';
import {
  formatDiagnosticsMarkdown,
  checkModelAvailability,
} from '../orchestrator/diagnostics.js';
import type { DiagnosticsReport } from '../orchestrator/diagnostics.js';

describe('formatDiagnosticsMarkdown', () => {
  it('formats a diagnostics report as markdown', () => {
    const report: DiagnosticsReport = {
      timestamp: new Date().toISOString(),
      registry_status: 'ok',
      models: [
        { model_id: 'gpt-4', provider: 'openai', reachable: true },
      ],
      provider_health: { openai: true },
      summary: { total: 1, reachable: 1, unreachable: 0 },
    };
    const output = formatDiagnosticsMarkdown(report, '1.0.0-test');
    expect(output).toContain('# Hive Diagnostics');
    expect(output).toContain('Models');
    expect(output).toContain('| Model |');
    expect(output).toContain('1.0.0-test');
  });
});

describe('checkModelAvailability', () => {
  it('is exported as a function', () => {
    expect(typeof checkModelAvailability).toBe('function');
  });
});
