import { describe, expect, it } from 'vitest';
import { parsePorcelainChangedFiles } from '../orchestrator/worktree-manager.js';

describe('worktree-manager', () => {
  describe('parsePorcelainChangedFiles', () => {
    it('preserves the full leading path segment', () => {
      const output = ' M mcp-server/index.ts\n';
      expect(parsePorcelainChangedFiles(output)).toEqual(['mcp-server/index.ts']);
    });

    it('handles multiple status lines without trimming file names incorrectly', () => {
      const output = 'M  orchestrator/driver.ts\n?? .hive/rules/mcp-surface.md\n';
      expect(parsePorcelainChangedFiles(output)).toEqual([
        'orchestrator/driver.ts',
        '.hive/rules/mcp-surface.md',
      ]);
    });

    it('returns the destination path for renames', () => {
      const output = 'R  docs/old.md -> docs/new.md\n';
      expect(parsePorcelainChangedFiles(output)).toEqual(['docs/new.md']);
    });

    it('drops untracked directory entries such as .ai/ and .claude/', () => {
      const output = '?? .ai/\n?? .claude/\n M README.md\n';
      expect(parsePorcelainChangedFiles(output)).toEqual(['README.md']);
    });

    it('drops transient internal file paths under .ai/ and .claude/', () => {
      const output = '?? .ai/restore/latest.md\n?? .claude/settings.local.json\n M src/app.ts\n';
      expect(parsePorcelainChangedFiles(output)).toEqual(['src/app.ts']);
    });
  });
});
