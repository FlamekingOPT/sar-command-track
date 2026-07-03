import { describe, it, expect } from 'vitest';
import { parseToken } from '../../src/firebase/token.js';

describe('parseToken', () => {
  it('extracts the token from /s/{token}', () => {
    expect(parseToken('/s/AbC123_-xYz9')).toBe('AbC123_-xYz9');
  });

  it('tolerates a trailing slash', () => {
    expect(parseToken('/s/AbC123_-xYz9/')).toBe('AbC123_-xYz9');
  });

  it('returns null for the root path', () => {
    expect(parseToken('/')).toBeNull();
  });

  it('returns null for /s/ with no token', () => {
    expect(parseToken('/s/')).toBeNull();
  });

  it('returns null for tokens with invalid characters', () => {
    expect(parseToken('/s/abc$%^')).toBeNull();
  });
});
