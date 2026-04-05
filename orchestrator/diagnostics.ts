// orchestrator/diagnostics.ts — Diagnostics and health check types

import type { ModelRegistry } from './model-registry.js';

// ── Health Check ──

export interface ModelHealthEntry {
  model_id: string;
  provider: string;
  reachable: boolean;
  latency_ms?: number;
  error?: string;
}

export interface DiagnosticsReport {
  timestamp: string;
  registry_status: 'ok' | 'degraded' | 'unavailable';
  models: ModelHealthEntry[];
  provider_health: Record<string, boolean>;
  summary: {
    total: number;
    reachable: number;
    unreachable: number;
  };
}

// ── Model Availability Check ──

export function formatDiagnosticsMarkdown(
  report: DiagnosticsReport,
  version: string,
): string {
  const lines: string[] = [
    '# Hive Diagnostics',
    '',
    `Version: ${version}`,
    `Status: ${report.registry_status}`,
    `Timestamp: ${report.timestamp}`,
    '',
    '## Models',
    '',
    '| Model | Provider | Reachable |',
    '|-------|----------|-----------|',
  ];
  for (const m of report.models) {
    lines.push(`| ${m.model_id} | ${m.provider} | ${m.reachable ? 'Yes' : 'No'} |`);
  }
  lines.push(
    '',
    `Summary: ${report.summary.reachable}/${report.summary.total} reachable`,
  );
  return lines.join('\n');
}

export function checkModelAvailability(registry: ModelRegistry): ModelHealthEntry[] {
  const models = registry.getAll();
  return models.map((model) => ({
    model_id: model.id,
    provider: model.provider,
    reachable: true,
  }));
}
