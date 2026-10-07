import { describe, expect, it } from 'vitest';
import { initials, updateCheckText } from './AccountMenu.js';

describe('initials', () => {
  it('takes the first and last word, or two letters of one word', () => {
    expect(initials('Abdulla Sheikh')).toBe('AS');
    expect(initials('Roshni Kumari Sahani')).toBe('RS');
    expect(initials('farheen')).toBe('FA');
    expect(initials('nileshd@aptask.com')).toBe('NI');
    expect(initials('  ')).toBe('?');
  });
});

describe('updateCheckText', () => {
  it('says what the check found, with the version', () => {
    expect(updateCheckText({ status: 'up_to_date' }, '0.1.14', false)).toBe(
      "You're up to date (version 0.1.14).",
    );
    expect(updateCheckText({ status: 'ready', version: '0.1.15' }, '0.1.14', false)).toBe(
      'Version 0.1.15 is ready. Choose Restart to update.',
    );
    expect(updateCheckText({ status: 'ready', version: '0.1.15' }, '0.1.14', true)).toBe(
      'Version 0.1.15 is downloaded. Clock out, then choose Restart to update.',
    );
  });

  it('turns failures into plain words', () => {
    expect(updateCheckText({ error: 'signed_out' }, null, false)).toBe(
      'Sign in again to check for updates.',
    );
    expect(updateCheckText({ error: 'not_configured' }, null, false)).toBe(
      "This copy of CloudPunch doesn't get updates.",
    );
    expect(updateCheckText({ error: 'offline' }, null, false)).toBe(
      "Couldn't check right now. Try again in a minute.",
    );
  });
});
