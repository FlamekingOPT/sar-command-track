export function parseSearchId(pathname) {
  const match = pathname.match(/^\/pick\/([A-Za-z0-9_-]+)\/?$/);
  return match ? match[1] : null;
}
