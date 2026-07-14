import { describe, it, expect } from 'vitest';
import { parseBoundaries } from '../../src/search/boundaries.js';

const GEOM = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };

describe('parseBoundaries', () => {
  it('parses the new boundaries array field', () => {
    const data = { boundaries: JSON.stringify([{ id: 'b1', geometry: GEOM }]) };
    expect(parseBoundaries(data)).toEqual([{ id: 'b1', geometry: GEOM }]);
  });

  it('shims a legacy single boundary into a one-element array', () => {
    const data = { boundary: JSON.stringify(GEOM) };
    expect(parseBoundaries(data)).toEqual([{ id: 'legacy-1', geometry: GEOM }]);
  });

  it('returns an empty array when neither field is set', () => {
    expect(parseBoundaries({})).toEqual([]);
    expect(parseBoundaries({ boundary: null, boundaries: null })).toEqual([]);
  });
});
