export function parseAvailableArgs(tokens) {
  const upper = tokens.map(t => t.toUpperCase());
  if (upper.length && upper[0].length > 1) {
    return { code: upper[0], letters: upper.slice(1) };
  }
  return { code: null, letters: upper };
}

export function pickSearch(activeSearches, code) {
  if (activeSearches.length === 0) return { error: 'no_active_search' };
  if (activeSearches.length === 1) return { search: activeSearches[0] };
  if (!code) return { error: 'code_required' };
  const search = activeSearches.find(s => s.code?.toUpperCase() === code.toUpperCase());
  return search ? { search } : { error: 'invalid_code' };
}
