import { describe, it, expect } from 'vitest';
import { greet } from './hello-test.js';

describe('greet', () => {
  it('should return "Hello, {name}!" format', () => {
    const result = greet('World');
    expect(result).toBe('Hello, World!');
  });

  it('should handle arbitrary names', () => {
    const result = greet('Hive');
    expect(result).toMatch(/^Hello, .+!$/);
  });
});
