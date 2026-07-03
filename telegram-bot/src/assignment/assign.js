const ASSIGNABLE = ['unassigned', 'needs_re_search'];

export function pickZone(zones, requestedLetters, lockedLetters = new Set()) {
  const letters = [...new Set(requestedLetters.map(l => l.toUpperCase()))];
  const unlockedRequested = letters.filter(l => !lockedLetters.has(l));
  const lockedRequested = letters.filter(l => lockedLetters.has(l));

  // 1. Normal: highest-need unlocked requested letter.
  const normal = pickByNeed(zones, unlockedRequested, ASSIGNABLE);
  if (normal) return normal;

  // 2. Locked requested letters: only sub-zones freed by a re-search flag may be offered.
  const reSearch = pickByNeed(zones, lockedRequested, ['needs_re_search']);
  if (reSearch) return reSearch;

  // 3. Fallback to OTHER letters exists only for the locked case (spec §4 item 3) —
  //    if the request merely hit full letters, return null so the bot can say so.
  //    ("Nearest available" is approximated by need-order; geographic nearest
  //    needs zone centroids — Plan 4.)
  if (!lockedRequested.length) return null;
  const others = [...new Set(zones.map(zn => zn.letter))]
    .filter(l => !lockedLetters.has(l) && !letters.includes(l));
  return pickByNeed(zones, others, ASSIGNABLE);
}

function pickByNeed(zones, letters, assignableStatuses) {
  let best = null;
  for (const letter of [...letters].sort()) {
    const letterZones = zones.filter(zn => zn.letter === letter);
    if (!letterZones.length) continue;
    const available = letterZones
      .filter(zn => assignableStatuses.includes(zn.status))
      .sort((a, b) => a.number - b.number);
    if (!available.length) continue;
    const assignedCount = letterZones.filter(zn => zn.assignedTo != null).length;
    const need = 1 - assignedCount / letterZones.length;
    if (!best || need > best.need) best = { need, zone: available[0] };
  }
  return best?.zone ?? null;
}
