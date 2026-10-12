import { describe, expect, it } from 'vitest';
import { pickSection, sectionsFor } from './sections.js';

const keys = (caps: string[]): string[] => sectionsFor(caps).map((s) => s.key);

describe('admin console sections (ADR-0038 §1)', () => {
  it('an Administrator sees everything but what needs another capability', () => {
    expect(
      keys([
        'admin.role.assign',
        'admin.shift.write',
        'hr.holiday.write',
        'admin.policy.write',
        'admin.device.read',
        'admin.connection.read',
      ]),
    ).toEqual(['people', 'managers', 'shifts', 'holidays', 'rules', 'computers', 'connections']);
  });

  it('HR sees People, Managers, Holidays and Rules', () => {
    expect(keys(['hr.employee.write', 'hr.holiday.write', 'hr.policy.write'])).toEqual([
      'people',
      'managers',
      'holidays',
      'rules',
    ]);
  });

  it('an Auditor sees Computers only', () => {
    expect(keys(['admin.device.read', 'audit.read.all'])).toEqual(['computers']);
  });

  it('an Employee or Manager sees nothing', () => {
    expect(keys(['self.correction.request', 'team.timeline.read'])).toEqual([]);
  });

  it('keeps the remembered section only if it is offered', () => {
    const hr = sectionsFor(['hr.employee.write', 'hr.policy.write']);
    expect(pickSection(hr, 'rules')).toBe('rules');
    expect(pickSection(hr, 'shifts')).toBe('people');
    expect(pickSection(hr, null)).toBe('people');
    expect(pickSection([], 'rules')).toBeNull();
  });
});
