import { describe, it, expect, beforeEach } from 'vitest';
import { getIdentity, saveName, getSavedRequest, saveRequest } from '../../src/pick/identity.js';

// In-memory localStorage stub — same globalThis-stubbing convention already
// used for globalThis.indexedDB in offlineQueue.test.js.
function fakeLocalStorage() {
  const store = new Map();
  return {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  };
}

beforeEach(() => {
  globalThis.localStorage = fakeLocalStorage();
});

describe('getIdentity', () => {
  it('generates and persists a UUID on first call', () => {
    const { id } = getIdentity();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(getIdentity().id).toBe(id); // same id on second call
  });

  it('returns null name when none saved yet', () => {
    expect(getIdentity().name).toBeNull();
  });

  it('returns the saved name after saveName', () => {
    saveName('Sarah Cohen');
    expect(getIdentity().name).toBe('Sarah Cohen');
  });

  it('keeps the same id across calls even after saving a name', () => {
    const first = getIdentity().id;
    saveName('Dana Levi');
    expect(getIdentity().id).toBe(first);
  });
});

describe('getSavedRequest / saveRequest', () => {
  it('returns null when nothing saved for this search', () => {
    expect(getSavedRequest('search-1')).toBeNull();
  });

  it('returns the saved request id, scoped per search', () => {
    saveRequest('search-1', 'req-abc');
    saveRequest('search-2', 'req-xyz');
    expect(getSavedRequest('search-1')).toBe('req-abc');
    expect(getSavedRequest('search-2')).toBe('req-xyz');
  });
});
