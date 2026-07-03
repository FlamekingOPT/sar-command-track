const STATUS_ORDER = { active: 0, setup: 1, complete: 2 };

export function sortSearches(searches) {
  return [...searches].sort((a, b) => {
    const statusDiff = statusRank(a.status) - statusRank(b.status);
    if (statusDiff !== 0) return statusDiff;
    return millis(b.createdAt) - millis(a.createdAt);
  });
}

function statusRank(status) {
  return STATUS_ORDER[status] ?? 3;
}

function millis(createdAt) {
  if (!createdAt) return Infinity; // no server timestamp yet — just created, treat as newest
  return typeof createdAt.toMillis === 'function' ? createdAt.toMillis() : createdAt;
}
