import { describe, it, expect } from 'vitest';
import { validateZonePolygon, zonesToGenerate } from '../../src/zones/reshape';

const square = {
  type: 'Polygon',
  coordinates: [[[0, 0], [0, 0.01], [0.01, 0.01], [0.01, 0], [0, 0]]],
};

describe('validateZonePolygon', () => {
  it('accepts a simple closed polygon', () => {
    const result = validateZonePolygon(square);
    expect(result.ok).toBe(true);
    expect(result.geometry).toEqual(square);
  });

  it('closes an unclosed ring rather than rejecting it', () => {
    const open = { type: 'Polygon', coordinates: [[[0, 0], [0, 0.01], [0.01, 0.01], [0.01, 0]]] };
    const result = validateZonePolygon(open);
    expect(result.ok).toBe(true);
    const ring = result.geometry.coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('rejects a bowtie the user dragged through itself', () => {
    const bowtie = {
      type: 'Polygon',
      coordinates: [[[0, 0], [0.01, 0.01], [0.01, 0], [0, 0.01], [0, 0]]],
    };
    expect(validateZonePolygon(bowtie).ok).toBe(false);
  });

  it('rejects a ring with fewer than three corners', () => {
    expect(validateZonePolygon({ type: 'Polygon', coordinates: [[[0, 0], [0, 1], [0, 0]]] }).ok).toBe(false);
  });

  it('rejects a zone collapsed to zero area', () => {
    const flat = { type: 'Polygon', coordinates: [[[0, 0], [0.01, 0], [0.02, 0], [0, 0]]] };
    expect(validateZonePolygon(flat).ok).toBe(false);
  });

  it('rejects non-polygon geometry', () => {
    expect(validateZonePolygon({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }).ok).toBe(false);
    expect(validateZonePolygon(null).ok).toBe(false);
  });
});

describe('zonesToGenerate', () => {
  it('uses the entered count as-is for the first generation', () => {
    expect(zonesToGenerate(25, 0)).toBe(25);
  });

  // The bug: adding a second boundary and asking for 20 more zones used to
  // compute 20 - 25 existing = 1 zone. The entered number is per-generation.
  it('ignores zones that already exist on other boundaries', () => {
    expect(zonesToGenerate(20, 25)).toBe(20);
  });

  it('never returns less than one', () => {
    expect(zonesToGenerate(0, 25)).toBe(1);
    expect(zonesToGenerate(-5, 0)).toBe(1);
  });
});
