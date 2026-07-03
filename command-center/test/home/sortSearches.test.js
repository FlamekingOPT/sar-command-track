import { describe, it, expect } from 'vitest';
import { sortSearches } from '../../src/home/sortSearches.js';

function ts(ms) {
  return { toMillis: () => ms }; // mimics a Firestore Timestamp
}

describe('sortSearches', () => {
  it('orders active before setup before complete', () => {
    const searches = [
      { id: 'c', status: 'complete', createdAt: ts(1) },
      { id: 'a', status: 'active', createdAt: ts(1) },
      { id: 's', status: 'setup', createdAt: ts(1) },
    ];
    expect(sortSearches(searches).map(s => s.id)).toEqual(['a', 's', 'c']);
  });

  it('orders newer createdAt first within the same status', () => {
    const searches = [
      { id: 'old', status: 'active', createdAt: ts(100) },
      { id: 'new', status: 'active', createdAt: ts(200) },
    ];
    expect(sortSearches(searches).map(s => s.id)).toEqual(['new', 'old']);
  });

  it('treats a missing createdAt as the most recent', () => {
    const searches = [
      { id: 'has-timestamp', status: 'active', createdAt: ts(999999) },
      { id: 'just-created', status: 'active', createdAt: null },
    ];
    expect(sortSearches(searches).map(s => s.id)).toEqual(['just-created', 'has-timestamp']);
  });

  it('accepts plain millisecond numbers for createdAt', () => {
    const searches = [
      { id: 'old', status: 'setup', createdAt: 100 },
      { id: 'new', status: 'setup', createdAt: 200 },
    ];
    expect(sortSearches(searches).map(s => s.id)).toEqual(['new', 'old']);
  });

  it('treats an unknown status as lowest priority', () => {
    const searches = [
      { id: 'weird', status: 'archived', createdAt: ts(1) },
      { id: 'done', status: 'complete', createdAt: ts(1) },
    ];
    expect(sortSearches(searches).map(s => s.id)).toEqual(['done', 'weird']);
  });

  it('does not mutate the input array', () => {
    const searches = [
      { id: 'c', status: 'complete', createdAt: ts(1) },
      { id: 'a', status: 'active', createdAt: ts(1) },
    ];
    const before = [...searches];
    sortSearches(searches);
    expect(searches).toEqual(before);
  });
});
