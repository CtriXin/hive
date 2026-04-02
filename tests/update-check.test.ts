import { describe, expect, it } from 'vitest';
import { isRemoteVersionNewer } from '../orchestrator/update-check.js';

describe('update-check', () => {
  describe('isRemoteVersionNewer', () => {
    it('returns true when remote major is newer', () => {
      expect(isRemoteVersionNewer('2.0.1', '3.0.0')).toBe(true);
    });

    it('returns true when remote minor is newer', () => {
      expect(isRemoteVersionNewer('2.0.1', '2.1.0')).toBe(true);
    });

    it('returns true when remote patch is newer', () => {
      expect(isRemoteVersionNewer('2.0.1', '2.0.2')).toBe(true);
    });

    it('returns false when versions are equal', () => {
      expect(isRemoteVersionNewer('2.0.1', '2.0.1')).toBe(false);
    });

    it('returns false when remote is older', () => {
      expect(isRemoteVersionNewer('2.1.0', '2.0.9')).toBe(false);
    });

    it('returns false for unparsable versions', () => {
      expect(isRemoteVersionNewer('dev', '2.0.2')).toBe(false);
      expect(isRemoteVersionNewer('2.0.1', 'main')).toBe(false);
    });
  });
});
