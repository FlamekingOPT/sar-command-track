import { describe, it, expect } from 'vitest';
import { parseRegisterName } from '../../src/commands/register.js';

describe('parseRegisterName', () => {
  it('extracts the name after /register', () => {
    expect(parseRegisterName('/register Sarah Cohen')).toBe('Sarah Cohen');
  });

  it('handles the @botname group form', () => {
    expect(parseRegisterName('/register@SarTrackBot Sarah Cohen')).toBe('Sarah Cohen');
  });

  it('returns empty string when no name given', () => {
    expect(parseRegisterName('/register')).toBe('');
    expect(parseRegisterName('/register   ')).toBe('');
  });

  it('collapses internal whitespace', () => {
    expect(parseRegisterName('/register  Sarah   Cohen ')).toBe('Sarah Cohen');
  });
});
