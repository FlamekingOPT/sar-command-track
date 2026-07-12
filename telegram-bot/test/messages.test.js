import { describe, it, expect } from 'vitest';
import { signupMessage, reSearchMessage, announcementCaption } from '../src/messages.js';

describe('signupMessage', () => {
  const search = { name: 'Main St Search', code: 'X7K2' };

  it('lists the search name and available letters', () => {
    const msg = signupMessage(search, ['A', 'B', 'C'], false);
    expect(msg).toContain('Main St Search');
    expect(msg).toContain('A, B, C');
  });

  it('omits the code when only one search is active', () => {
    const msg = signupMessage(search, ['A'], false);
    expect(msg).not.toContain('X7K2');
    expect(msg).toContain('/available A');
  });

  it('includes the code in the example command when multiple searches are active', () => {
    const msg = signupMessage(search, ['A', 'B'], true);
    expect(msg).toContain('X7K2');
    expect(msg).toContain('/available X7K2 A');
  });
});

describe('reSearchMessage', () => {
  it('names the zone and gives the exact command', () => {
    const msg = reSearchMessage({ letter: 'A', number: 3 });
    expect(msg).toContain('Zone A3');
    expect(msg).toContain('/available A');
  });
});

describe('announcementCaption', () => {
  it('names the search and includes both links', () => {
    const msg = announcementCaption(
      { name: 'Main St Search' },
      'https://t.me/+abc123',
      'https://sar-searcher.web.app/pick/s1'
    );
    expect(msg).toContain('Main St Search');
    expect(msg).toContain('https://t.me/+abc123');
    expect(msg).toContain('https://sar-searcher.web.app/pick/s1');
  });
});
