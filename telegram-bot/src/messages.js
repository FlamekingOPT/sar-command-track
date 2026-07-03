export function signupMessage(search, letters, includeCode) {
  const zoneList = letters.join(', ');
  const example = includeCode
    ? `/available ${search.code} ${letters[0] ?? 'A'}`
    : `/available ${letters[0] ?? 'A'}`;
  return [
    `🔍 Search: ${search.name}`,
    `Available zones: ${zoneList}`,
    `Reply ${example} with the zone letters you can search. You'll be assigned one zone based on where coverage is needed most.`,
    ...(includeCode ? [`(Multiple searches are active — include the code ${search.code} for this one.)`] : []),
  ].join('\n');
}

export function reSearchMessage(zone) {
  return `⚠️ Zone ${zone.letter}${zone.number} needs re-search — reply /available ${zone.letter} to help.`;
}
