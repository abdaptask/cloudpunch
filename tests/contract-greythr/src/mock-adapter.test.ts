import type { AttendanceExportRecord, GreythrEmployee } from '@cloudpunch/shared';
import { describe, expect, it } from 'vitest';
import { GreythrMockAdapter } from './mock-adapter.js';

const emp = (id: string, status: GreythrEmployee['status'] = 'active'): GreythrEmployee => ({
  greythrEmployeeId: id,
  employeeNumber: id,
  workEmail: `${id.toLowerCase()}@aptask.com`,
  givenName: 'Test',
  middleName: null,
  familyName: id,
  displayName: null,
  status,
  departmentCode: 'ENG',
  reportingManagerGreythrId: null,
  locationCode: null,
  costCenterCode: null,
  defaultShiftCode: null,
  hireDate: '2024-01-01',
  terminationDate: null,
});

const export1 = (idempotencyKey: string): AttendanceExportRecord => ({
  timesheetId: 'ts-1',
  timesheetVersion: 1,
  payrollPeriodId: 'pp-1',
  attendanceDate: '2026-09-22',
  greythrEmployeeId: 'E001',
  approvedClockInAt: '2026-09-22T09:00:00+05:30',
  approvedClockOutAt: '2026-09-22T17:00:00+05:30',
  regularHours: 8,
  overtimeHours: 0,
  paidBreakMinutes: 10,
  unpaidBreakMinutes: 60,
  status: 'P',
  shiftCode: null,
  leaveType: null,
  adjustmentReason: null,
  projectCode: null,
  costCenterCode: null,
  idempotencyKey,
});

describe('GreythrMockAdapter — capability gating', () => {
  it('ping and describeCapabilities work with no capabilities advertised', async () => {
    const a = new GreythrMockAdapter();
    await expect(a.ping()).resolves.toMatchObject({ ok: true });
    const caps = a.describeCapabilities();
    expect(caps.readEmployees).toBe(false);
    expect(caps.writeAttendance).toBe(false);
  });

  it('throws a clear error if a method is called without its capability', async () => {
    const a = new GreythrMockAdapter();
    await expect(a.listActiveEmployees()).rejects.toThrow(/readEmployees/);
    await expect(a.getEmployee('E1')).rejects.toThrow(/readEmployees/);
    await expect(a.getHolidayCalendar(2026)).rejects.toThrow(/readHolidays/);
    await expect(a.getApprovedLeave()).rejects.toThrow(/readLeave/);
    await expect(a.getShiftAssignments()).rejects.toThrow(/readShifts/);
    await expect(a.postApprovedAttendance([])).rejects.toThrow(/writeAttendance/);
  });

  it('enables listActiveEmployees when readEmployees is advertised', async () => {
    const a = new GreythrMockAdapter({
      employees: [emp('E001'), emp('E002', 'terminated'), emp('E003')],
      capabilities: { readEmployees: true },
    });
    const page = await a.listActiveEmployees();
    expect(page.items).toHaveLength(2);
    expect(page.items.map((e) => e.greythrEmployeeId)).toEqual(['E001', 'E003']);
    expect(page.nextCursor).toBeNull();
  });

  it('gates delta reads behind readEmployeesDelta when since is passed', async () => {
    const a = new GreythrMockAdapter({
      employees: [emp('E001')],
      capabilities: { readEmployees: true, readEmployeesDelta: false },
    });
    await expect(a.listActiveEmployees(undefined, new Date('2024-01-01'))).rejects.toThrow(
      /readEmployeesDelta/,
    );
  });
});

describe('GreythrMockAdapter — attendance export idempotency', () => {
  it('returns accepted for a fresh idempotency key', async () => {
    const a = new GreythrMockAdapter({ capabilities: { writeAttendance: true } });
    const res = await a.postApprovedAttendance([export1('abc123')]);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.status).toBe('accepted');
    expect(res.items[0]?.externalReferenceId).toMatch(/^mock-/);
  });

  it('returns duplicate_noop with the pre-existing reference for a known key', async () => {
    const a = new GreythrMockAdapter({
      capabilities: { writeAttendance: true },
      existingAttendanceByKey: new Map([['abc123', 'greythr-att-42']]),
    });
    const res = await a.postApprovedAttendance([export1('abc123')]);
    expect(res.items[0]?.status).toBe('duplicate_noop');
    expect(res.items[0]?.externalReferenceId).toBe('greythr-att-42');
  });

  it('records every export call for later assertion', async () => {
    const a = new GreythrMockAdapter({ capabilities: { writeAttendance: true } });
    await a.postApprovedAttendance([export1('k1')]);
    await a.postApprovedAttendance([export1('k2'), export1('k3')]);
    expect(a.exportCalls).toHaveLength(2);
    expect(a.exportCalls[0]).toHaveLength(1);
    expect(a.exportCalls[1]).toHaveLength(2);
  });
});

describe('GreythrMockAdapter — CapabilitySet contract', () => {
  it('advertises the full CapabilitySet shape (all keys present, all boolean)', () => {
    const a = new GreythrMockAdapter();
    const caps = a.describeCapabilities();
    const expectedKeys: Array<keyof typeof caps> = [
      'readEmployees',
      'readEmployeesDelta',
      'readHolidays',
      'readLeave',
      'readShifts',
      'writeAttendance',
      'writeAttendanceCorrection',
      'webhooksTermination',
    ];
    for (const k of expectedKeys) {
      expect(caps[k]).toBeTypeOf('boolean');
    }
  });
});
