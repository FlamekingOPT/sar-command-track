import { describe, it, expect } from 'vitest';
import { lngLatToTile, tilesForBbox, tileUrlsFromTemplate } from '../../src/map/tileMath.js';

describe('lngLatToTile', () => {
  it('maps the null island at z1 to tile 1,1', () => {
    expect(lngLatToTile(0, 0, 1)).toEqual({ x: 1, y: 1, z: 1 });
  });

  it('maps the top-left of the world to tile 0,0', () => {
    expect(lngLatToTile(-180, 85.05, 2)).toEqual({ x: 0, y: 0, z: 2 });
  });

  it('x grows east, y grows south', () => {
    const west = lngLatToTile(-118.3, 34.05, 14);
    const east = lngLatToTile(-118.2, 34.05, 14);
    const north = lngLatToTile(-118.25, 34.10, 14);
    const south = lngLatToTile(-118.25, 34.00, 14);
    expect(east.x).toBeGreaterThan(west.x);
    expect(south.y).toBeGreaterThan(north.y);
  });
});

describe('tilesForBbox', () => {
  const BBOX = [-118.26, 34.04, -118.24, 34.06]; // ~2km urban zone

  it('returns tiles for every requested zoom', () => {
    const tiles = tilesForBbox(BBOX, [14, 15]);
    expect(tiles.some(t => t.z === 14)).toBe(true);
    expect(tiles.some(t => t.z === 15)).toBe(true);
  });

  it('covers all four bbox corners at each zoom', () => {
    const tiles = tilesForBbox(BBOX, [16]);
    const corners = [
      lngLatToTile(BBOX[0], BBOX[1], 16), lngLatToTile(BBOX[0], BBOX[3], 16),
      lngLatToTile(BBOX[2], BBOX[1], 16), lngLatToTile(BBOX[2], BBOX[3], 16),
    ];
    for (const c of corners) {
      expect(tiles.some(t => t.x === c.x && t.y === c.y && t.z === 16)).toBe(true);
    }
  });

  it('tile count roughly quadruples per zoom level', () => {
    const z15 = tilesForBbox(BBOX, [15]).length;
    const z17 = tilesForBbox(BBOX, [17]).length;
    expect(z17).toBeGreaterThan(z15 * 4);
  });
});

describe('tileUrlsFromTemplate', () => {
  it('substitutes z/x/y into the template', () => {
    const urls = tileUrlsFromTemplate(
      'https://api.mapbox.com/v4/composite/{z}/{x}/{y}.vector.pbf?access_token=T',
      [{ x: 2810, y: 6541, z: 14 }]
    );
    expect(urls).toEqual(['https://api.mapbox.com/v4/composite/14/2810/6541.vector.pbf?access_token=T']);
  });
});
