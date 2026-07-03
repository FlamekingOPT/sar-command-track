### Task 1: Search List Sort Order (TDD)

**Files:**
- Create: `command-center/src/home/sortSearches.js`
- Test: `command-center/test/home/sortSearches.test.js`

**Interfaces:**
- Produces: `sortSearches(searches: Array<{ id, status, createdAt }>): Array<search>` — pure, does not mutate its input. Sort key: `status` priority (`active` → `setup` → `complete` → anything else last), then `createdAt` descending within a status group. A `createdAt` of `null`/`undefined` (a doc whose `serverTimestamp()` hasn't resolved yet) sorts as the newest.
- Consumed by: Task 3 (`HomeDashboard`)

- [ ] **Step 1: Write failing tests**

```javascript
// command-center/test/home/sortSearches.test.js
import { describe, it, expect } from 'vitest';
import { sortSearches } from '../../src/home/sortSearches.js';

function ts(ms) {
  return { toMillis: () => ms }; // mimics a Firestore Timestamp
}

describe('sortSearches', () => {
  it('orders active before setup before complete', () => {
    const searches = [
      { id: 'c', status: 'complete', createdAt: ts(1) },
      { id: 'a', status: 'active', createdAt: ts(1) },
      { id: 's', status: 'setup', createdAt: ts(1) },
    ];
    expect(sortSearches(searches).map(s => s.id)).toEqual(['a', 's', 'c']);
  });

  it('orders newer createdAt first within the same status', () => {
    const searches = [
      { id: 'old', status: 'active', createdAt: ts(100) },
      { id: 'new', status: 'active', createdAt: ts(200) },
    ];
    expect(sortSearches(searches).map(s => s.id)).toEqual(['new', 'old']);
  });

  it('treats a missing createdAt as the most recent', () => {
    const searches = [
      { id: 'has-timestamp', status: 'active', createdAt: ts(999999) },
      { id: 'just-created', status: 'active', createdAt: null },
    ];
    expect(sortSearches(searches).map(s => s.id)).toEqual(['just-created', 'has-timestamp']);
  });

  it('accepts plain millisecond numbers for createdAt', () => {
    const searches = [
      { id: 'old', status: 'setup', createdAt: 100 },
      { id: 'new', status: 'setup', createdAt: 200 },
    ];
    expect(sortSearches(searches).map(s => s.id)).toEqual(['new', 'old']);
  });

  it('treats an unknown status as lowest priority', () => {
    const searches = [
      { id: 'weird', status: 'archived', createdAt: ts(1) },
      { id: 'done', status: 'complete', createdAt: ts(1) },
    ];
    expect(sortSearches(searches).map(s => s.id)).toEqual(['done', 'weird']);
  });

  it('does not mutate the input array', () => {
    const searches = [
      { id: 'c', status: 'complete', createdAt: ts(1) },
      { id: 'a', status: 'active', createdAt: ts(1) },
    ];
    const before = [...searches];
    sortSearches(searches);
    expect(searches).toEqual(before);
  });
});
```

- [ ] **Step 2: Run — confirm failure**

```bash
cd "C:\Users\Jack\dev\sar-command-track\command-center"
npm test
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement sortSearches.js**

```javascript
// command-center/src/home/sortSearches.js
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
```

- [ ] **Step 4: Run — confirm pass**

```bash
npm test
```
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add command-center/src/home/sortSearches.js command-center/test/home/sortSearches.test.js
git commit -m "feat(cc): search list sort order (TDD) — active, then setup, then complete"
```

---

