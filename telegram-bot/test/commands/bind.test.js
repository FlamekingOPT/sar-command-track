import { describe, it, expect } from 'vitest';
import { parseBindArgs } from '../../src/commands/bind.js';

describe('parseBindArgs', () => {
  it('extracts and uppercases the code', () => {
    expect(parseBindArgs('/bind x7k2')).toEqual({ code: 'X7K2' });
  });

  it('handles the @botname group form', () => {
    expect(parseBindArgs('/bind@SarTrackBot x7k2')).toEqual({ code: 'X7K2' });
  });

  it('returns null code when none given', () => {
    expect(parseBindArgs('/bind')).toEqual({ code: null });
    expect(parseBindArgs('/bind   ')).toEqual({ code: null });
  });
});
