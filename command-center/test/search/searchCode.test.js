import { describe, it, expect } from 'vitest';
import { generateSearchCode, CODE_ALPHABET } from '../../src/search/searchCode.js';

describe('generateSearchCode', () => {
  it('returns 4 characters', () => {
    expect(generateSearchCode()).toHaveLength(4);
  });

  it('only uses unambiguous alphabet characters', () => {
    for (let i = 0; i < 50; i++) {
      for (const ch of generateSearchCode()) {
        expect(CODE_ALPHABET).toContain(ch);
      }
    }
  });

  it('excludes ambiguous characters from the alphabet', () => {
    for (const bad of ['0', 'O', '1', 'I', 'L']) {
      expect(CODE_ALPHABET).not.toContain(bad);
    }
  });

  it('is deterministic given a seeded random source', () => {
    const fakeRandom = () => 0; // always first alphabet char
    expect(generateSearchCode(fakeRandom)).toBe(CODE_ALPHABET[0].repeat(4));
  });
});
