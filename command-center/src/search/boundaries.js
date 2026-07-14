// Legacy searches store a single `boundary` (stringified geometry); newer ones
// store `boundaries` (stringified array of {id, geometry}). Normalize both to
// the array shape so nothing downstream ever sees the legacy field. Kept
// firebase-free so it's unit-testable without initializing the app.
export function parseBoundaries(data) {
  if (data.boundaries) return JSON.parse(data.boundaries);
  if (data.boundary) return [{ id: 'legacy-1', geometry: JSON.parse(data.boundary) }];
  return [];
}
