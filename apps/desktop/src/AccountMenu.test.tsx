import { describe, expect, it } from 'vitest';
import { initials } from './AccountMenu.js';

describe('initials', () => {
  it('takes the first and last word, or two letters of one word', () => {
    expect(initials('Abdulla Sheikh')).toBe('AS');
    expect(initials('Roshni Kumari Sahani')).toBe('RS');
    expect(initials('farheen')).toBe('FA');
    expect(initials('nileshd@aptask.com')).toBe('NI');
    expect(initials('  ')).toBe('?');
  });
});
