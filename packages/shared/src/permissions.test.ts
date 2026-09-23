import { describe, expect, it } from 'vitest';
import { ALL_APP_ROLES, AppRole, filterKnownRoles, isAppRole } from './roles.js';
import {
  Capability,
  ROLE_CAPABILITIES,
  capabilitiesForRoles,
  hasAnyCapability,
  hasCapability,
} from './permissions.js';

describe('AppRole', () => {
  it('exposes exactly six roles', () => {
    expect(ALL_APP_ROLES).toHaveLength(6);
    expect(new Set(ALL_APP_ROLES).size).toBe(6);
  });

  it('accepts every declared role via isAppRole', () => {
    for (const r of ALL_APP_ROLES) {
      expect(isAppRole(r)).toBe(true);
    }
  });

  it('rejects unknown strings and non-strings', () => {
    expect(isAppRole('SuperAdmin')).toBe(false);
    expect(isAppRole('employee')).toBe(false); // case sensitive
    expect(isAppRole('')).toBe(false);
    expect(isAppRole(42)).toBe(false);
    expect(isAppRole(null)).toBe(false);
    expect(isAppRole(undefined)).toBe(false);
    expect(isAppRole({})).toBe(false);
  });

  it('filterKnownRoles drops unknowns and deduplicates', () => {
    const result = filterKnownRoles([
      'Employee',
      'Employee',
      'Manager',
      'RogueRole',
      42,
      null,
      'Auditor',
    ]);
    expect(new Set(result)).toEqual(new Set(['Employee', 'Manager', 'Auditor']));
  });
});

describe('ROLE_CAPABILITIES', () => {
  it('has an entry for every role', () => {
    for (const r of ALL_APP_ROLES) {
      expect(ROLE_CAPABILITIES[r]).toBeDefined();
      expect(ROLE_CAPABILITIES[r].length).toBeGreaterThan(0);
    }
  });

  // Separation-of-duties invariants — these tests exist so the RBAC
  // contract cannot be weakened silently.

  it('Administrator does NOT include payroll capabilities', () => {
    expect(ROLE_CAPABILITIES[AppRole.Administrator]).not.toContain(Capability.PayrollExport);
    expect(ROLE_CAPABILITIES[AppRole.Administrator]).not.toContain(Capability.PayrollApprovedRead);
    expect(ROLE_CAPABILITIES[AppRole.Administrator]).not.toContain(
      Capability.PayrollPeriodLockToggle,
    );
  });

  it('Administrator does NOT include audit read capabilities', () => {
    expect(ROLE_CAPABILITIES[AppRole.Administrator]).not.toContain(Capability.AuditReadAll);
    expect(ROLE_CAPABILITIES[AppRole.Administrator]).not.toContain(Capability.AuditReadEvents);
  });

  it('Payroll cannot alter employee records', () => {
    expect(hasCapability([AppRole.Payroll], Capability.HrEmployeeWrite)).toBe(false);
    expect(hasCapability([AppRole.Payroll], Capability.AdminEmployeeAssignRole)).toBe(false);
  });

  it('Auditor has ONLY read capabilities (no write-style verbs)', () => {
    const auditorCaps = ROLE_CAPABILITIES[AppRole.Auditor];
    for (const c of auditorCaps) {
      expect(c).not.toMatch(
        /write|approve|assign|revoke|certify|export|toggle|configure|request|act\b/i,
      );
    }
  });

  it('Employee cannot approve team timesheets', () => {
    expect(hasCapability([AppRole.Employee], Capability.TeamTimesheetApprove)).toBe(false);
  });

  it('Manager can approve team timesheets', () => {
    expect(hasCapability([AppRole.Manager], Capability.TeamTimesheetApprove)).toBe(true);
  });

  it('HR gets team-visibility without being a Manager', () => {
    expect(hasCapability([AppRole.HR], Capability.TeamTimelineRead)).toBe(true);
    expect(hasCapability([AppRole.HR], Capability.HrEmployeeWrite)).toBe(true);
  });
});

describe('capabilitiesForRoles', () => {
  it('unions capabilities across multiple roles', () => {
    const caps = capabilitiesForRoles([AppRole.Employee, AppRole.Manager]);
    expect(caps.has(Capability.SelfClockWrite)).toBe(true);
    expect(caps.has(Capability.TeamTimesheetApprove)).toBe(true);
  });

  it('is empty for an empty role set', () => {
    expect(capabilitiesForRoles([]).size).toBe(0);
  });

  it('deduplicates when two roles grant the same capability', () => {
    // HR and Administrator both grant HrEmployeeWrite
    const caps = capabilitiesForRoles([AppRole.HR, AppRole.Administrator]);
    let hits = 0;
    for (const c of caps) if (c === Capability.HrEmployeeWrite) hits++;
    expect(hits).toBe(1);
  });
});

describe('hasCapability and hasAnyCapability', () => {
  it('hasCapability short-circuits on the first matching role', () => {
    expect(
      hasCapability([AppRole.Employee, AppRole.Manager], Capability.TeamTimesheetApprove),
    ).toBe(true);
  });

  it('hasCapability returns false when no role grants it', () => {
    expect(hasCapability([AppRole.Employee], Capability.AdminConfigWrite)).toBe(false);
  });

  it('hasAnyCapability returns true if any required is granted', () => {
    expect(
      hasAnyCapability(
        [AppRole.Employee],
        [Capability.AdminConfigWrite, Capability.SelfClockWrite],
      ),
    ).toBe(true);
  });

  it('hasAnyCapability returns false when none are granted', () => {
    expect(
      hasAnyCapability(
        [AppRole.Employee],
        [Capability.AdminConfigWrite, Capability.PayrollExport],
      ),
    ).toBe(false);
  });
});
