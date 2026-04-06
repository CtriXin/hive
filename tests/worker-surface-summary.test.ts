import { describe, expect, it } from 'vitest';
import { pickWorkerSurfaceSummary, summarizeWorkerSurfaceText } from '../orchestrator/worker-surface-summary.js';

describe('worker-surface-summary', () => {
  it('returns plain text unchanged when already human-readable', () => {
    expect(summarizeWorkerSurfaceText('Applying final doc edits')).toBe('Applying final doc edits');
  });

  it('summarizes tool_use payloads into short readable text', () => {
    expect(
      summarizeWorkerSurfaceText('{"type":"tool_use","id":"tool_1","name":"Read","input":{"file_path":"README.md"}}'),
    ).toBe('Running tool: Read');
  });

  it('summarizes truncated tool_use payloads into short readable text', () => {
    expect(
      summarizeWorkerSurfaceText('{"type":"tool_use","id":"tool_1","name":"Bash","input":{"command":"ls -la /tmp/very-long-path...'),
    ).toBe('Running tool: Bash');
  });

  it('unwraps assistant payloads that contain nested tool_use content', () => {
    expect(
      summarizeWorkerSurfaceText('{"type":"assistant","content":"{\\"type\\":\\"tool_use\\",\\"name\\":\\"Bash\\"}"}'),
    ).toBe('Running tool: Bash');
  });

  it('prefers the first meaningful sanitized candidate', () => {
    expect(
      pickWorkerSurfaceSummary(
        '',
        '{"type":"system","subtype":"init"}',
        'Fallback summary',
      ),
    ).toBe('Worker session started');
  });
});
