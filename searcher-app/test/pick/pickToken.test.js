import { describe, it, expect } from 'vitest';
import { parseSearchId } from '../../src/pick/pickToken.js';

describe('parseSearchId', () => {
  it('extracts the search id from /pick/{searchId}', () => {
    expect(parseSearchId('/pick/AbC123_-xYz9')).toBe('AbC123_-xYz9');
  });

  it('tolerates a trailing slash', () => {
    expect(parseSearchId('/pick/AbC123_-xYz9/')).toBe('AbC123_-xYz9');
  });

  it('returns null for the root path', () => {
    expect(parseSearchId('/')).toBeNull();
  });

  it('returns null for /pick/ with no id', () => {
    expect(parseSearchId('/pick/')).toBeNull();
  });

  it('returns null for a /s/{token} path', () => {
    expect(parseSearchId('/s/AbC123')).toBeNull();
  });

  it('returns null for ids with invalid characters', () => {
    expect(parseSearchId('/pick/abc$%^')).toBeNull();
  });
});
