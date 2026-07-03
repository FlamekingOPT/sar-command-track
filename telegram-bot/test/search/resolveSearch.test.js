import { describe, it, expect } from 'vitest';
import { parseAvailableArgs, pickSearch } from '../../src/search/resolveSearch.js';

describe('parseAvailableArgs', () => {
  it('treats all single-char tokens as letters, uppercased', () => {
    expect(parseAvailableArgs(['a', 'B'])).toEqual({ code: null, letters: ['A', 'B'] });
  });

  it('treats a multi-char first token as the search code', () => {
    expect(parseAvailableArgs(['x7k2', 'a', 'b'])).toEqual({ code: 'X7K2', letters: ['A', 'B'] });
  });

  it('handles empty input', () => {
    expect(parseAvailableArgs([])).toEqual({ code: null, letters: [] });
  });
});

const SEARCH_A = { id: 's1', name: 'Main St', code: 'X7K2' };
const SEARCH_B = { id: 's2', name: 'Riverside', code: 'P3QM' };

describe('pickSearch', () => {
  it('errors when no search is active', () => {
    expect(pickSearch([], null)).toEqual({ error: 'no_active_search' });
  });

  it('uses the single active search, ignoring any code given', () => {
    expect(pickSearch([SEARCH_A], null)).toEqual({ search: SEARCH_A });
    expect(pickSearch([SEARCH_A], 'WRONG')).toEqual({ search: SEARCH_A });
  });

  it('requires a code when multiple searches are active', () => {
    expect(pickSearch([SEARCH_A, SEARCH_B], null)).toEqual({ error: 'code_required' });
  });

  it('matches code case-insensitively across multiple searches', () => {
    expect(pickSearch([SEARCH_A, SEARCH_B], 'p3qm')).toEqual({ search: SEARCH_B });
  });

  it('errors on an unrecognized code', () => {
    expect(pickSearch([SEARCH_A, SEARCH_B], 'ZZZZ')).toEqual({ error: 'invalid_code' });
  });
});
