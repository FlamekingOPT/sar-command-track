import { describe, it, expect } from 'vitest';
import { pickZone } from '../../src/assignment/assign.js';

// Helper: build a zone doc
const z = (letter, number, status = 'unassigned', assignedTo = null) =>
  ({ id: `${letter}${number}`, letter, number, status, assignedTo });

describe('pickZone', () => {
  it('assigns the letter with the greatest need (3 of 4 assigned in A, 1 of 4 in B → B)', () => {
    const zones = [
      z('A', 1, 'assigned', 'v1'), z('A', 2, 'assigned', 'v2'), z('A', 3, 'assigned', 'v3'), z('A', 4),
      z('B', 1, 'assigned', 'v4'), z('B', 2), z('B', 3), z('B', 4),
    ];
    expect(pickZone(zones, ['A', 'B']).id).toBe('B2');
  });

  it('breaks ties within a letter by lowest sub-zone number', () => {
    const zones = [z('A', 3), z('A', 1), z('A', 2)];
    expect(pickZone(zones, ['A']).id).toBe('A1');
  });

  it('treats needs_re_search sub-zones as assignable', () => {
    const zones = [
      z('A', 1, 'searched', 'v1'), z('A', 2, 'needs_re_search', 'v1'),
    ];
    expect(pickZone(zones, ['A']).id).toBe('A2');
  });

  it('returns null when no requested letter has an assignable sub-zone and no fallback exists', () => {
    const zones = [z('A', 1, 'assigned', 'v1'), z('A', 2, 'in_progress', 'v2')];
    expect(pickZone(zones, ['A'])).toBeNull();
  });

  it('does NOT fall back to unrequested letters when requested letters are merely full (not locked)', () => {
    const zones = [z('A', 1, 'assigned', 'v1'), z('B', 1)];
    expect(pickZone(zones, ['A'])).toBeNull(); // volunteer asked for A only; B stays untouched
  });

  it('ignores letters that do not exist in the search', () => {
    const zones = [z('A', 1)];
    expect(pickZone(zones, ['Q', 'A']).id).toBe('A1');
  });

  it('excludes locked letters from normal assignment, falling back to an unlocked letter', () => {
    const zones = [z('A', 1), z('B', 1)];
    expect(pickZone(zones, ['A'], new Set(['A'])).id).toBe('B1');
  });

  it('offers a needs_re_search sub-zone in a locked requested letter before falling back', () => {
    const zones = [z('A', 1, 'needs_re_search', 'v1'), z('A', 2, 'assigned', 'v2'), z('B', 1)];
    expect(pickZone(zones, ['A'], new Set(['A'])).id).toBe('A1');
  });

  it('deduplicates and uppercases requested letters', () => {
    const zones = [z('A', 1)];
    expect(pickZone(zones, ['a', 'A', 'a']).id).toBe('A1');
  });
});
