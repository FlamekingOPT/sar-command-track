import { describe, it, expect } from 'vitest';
import { generateToken } from '../../src/firebase/tokens.js';

describe('generateToken', () => {
  it('returns a 12-character token', () => {
    expect(generateToken()).toHaveLength(12);
  });

  it('only contains URL-safe characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('does not repeat across 1000 generations', () => {
    const seen = new Set(Array.from({ length: 1000 }, generateToken));
    expect(seen.size).toBe(1000);
  });
});
