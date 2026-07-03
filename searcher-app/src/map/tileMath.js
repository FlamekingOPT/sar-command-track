export function lngLatToTile(lng, lat, z) {
  const n = 2 ** z;
  const x = Math.min(n - 1, Math.floor(((lng + 180) / 360) * n));
  const latRad = (lat * Math.PI) / 180;
  const y = Math.min(
    n - 1,
    Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
  );
  return { x: Math.max(0, x), y: Math.max(0, y), z };
}

export function tilesForBbox([minX, minY, maxX, maxY], zooms = [14, 15, 16, 17]) {
  const tiles = [];
  for (const z of zooms) {
    const topLeft = lngLatToTile(minX, maxY, z);
    const bottomRight = lngLatToTile(maxX, minY, z);
    for (let x = topLeft.x; x <= bottomRight.x; x++) {
      for (let y = topLeft.y; y <= bottomRight.y; y++) {
        tiles.push({ x, y, z });
      }
    }
  }
  return tiles;
}

export function tileUrlsFromTemplate(template, tiles) {
  return tiles.map(t =>
    template.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y)
  );
}
