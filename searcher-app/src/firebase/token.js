export function parseToken(pathname) {
  const match = pathname.match(/^\/s\/([A-Za-z0-9_-]+)\/?$/);
  return match ? match[1] : null;
}
