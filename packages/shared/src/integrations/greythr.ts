/**
 * greytHR adapter contract. Everything the CloudPunch backend needs from
 * greytHR flows through this interface — the concrete implementation
 * (API, CSV, mock) is decided at boot per ADR-0006 §1.
 *
 * These types are the stable internal shape. Field-level mapping to
 * greytHR's actual API payloads lives in
 * `docs/integrations/greythr-mapping-rfc.md` and is confirmed once
 * Greytip Software publishes the current API docs to apTask.
 */

export type EmploymentStatus = 'active' | 'inactive' | 'terminated' | 'on_leave';

export interface GreythrEmployee {
  greythrEmployeeId: string;
  employeeNumber: string | null;
  workEmail: string;
  givenName: string;
  middleName: string | null;
  familyName: string;
  displayName: string | null;
  status: EmploymentStatus;
  departmentCode: string | null;
  reportingManagerGreythrId: string | null;
  locationCode: string | null;
  costCenterCode: string | null;
  defaultShiftCode: string | null;
  hireDate: string | null; // ISO 8601 yyyy-MM-dd
  terminationDate: string | null;
}

export interface GreythrHoliday {
  calendarCode: string;
  name: string;
  date: string; // yyyy-MM-dd
  type: 'public' | 'restricted' | 'optional' | 'other';
}

export interface GreythrLeave {
  greythrLeaveId: string;
  greythrEmployeeId: string;
  leaveType: string; // mapped to CloudPunch enum in loader; raw here
  startDate: string; // yyyy-MM-dd
  endDate: string; // yyyy-MM-dd
  dayFraction: 'full' | 'half' | 'quarter' | null;
  status: 'approved' | 'pending' | 'rejected' | 'cancelled';
}

export interface GreythrShiftAssignment {
  greythrAssignmentId: string;
  greythrEmployeeId: string;
  shiftCode: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface AttendanceExportRecord {
  timesheetId: string;
  timesheetVersion: number;
  payrollPeriodId: string;
  attendanceDate: string; // yyyy-MM-dd
  greythrEmployeeId: string;
  approvedClockInAt: string; // ISO 8601 with tz
  approvedClockOutAt: string;
  regularHours: number;
  overtimeHours: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  status: 'P' | 'HD' | 'WFH' | 'A' | 'LEAVE' | 'HOL';
  shiftCode: string | null;
  leaveType: string | null;
  adjustmentReason: string | null;
  projectCode: string | null;
  costCenterCode: string | null;
  idempotencyKey: string;
}

export interface BulkExportResultItem {
  idempotencyKey: string;
  status: 'accepted' | 'duplicate_noop' | 'rejected';
  externalReferenceId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface BulkExportResult {
  items: readonly BulkExportResultItem[];
}

export interface AttendanceExistsResult {
  exists: boolean;
  externalReferenceId: string | null;
  idempotencyKey: string | null;
}

export interface Page<T> {
  items: readonly T[];
  /** Opaque cursor for the next page; null when at end. */
  nextCursor: string | null;
}

export interface HealthProbeResult {
  ok: boolean;
  latencyMs?: number | undefined;
  detail?: string | undefined;
}

/**
 * Capability advertisement from an adapter. The backend feature-flags on
 * this so an under-provisioned greytHR plan cannot silently be treated
 * as fully-featured.
 */
export interface CapabilitySet {
  readEmployees: boolean;
  readEmployeesDelta: boolean;
  readHolidays: boolean;
  readLeave: boolean;
  readShifts: boolean;
  writeAttendance: boolean;
  writeAttendanceCorrection: boolean;
  webhooksTermination: boolean;
}

export interface GreythrAdapter {
  // Health + metadata
  ping(): Promise<HealthProbeResult>;
  describeCapabilities(): CapabilitySet;

  // Inbound
  listActiveEmployees(cursor?: string, since?: Date): Promise<Page<GreythrEmployee>>;
  getEmployee(greythrEmployeeId: string): Promise<GreythrEmployee | null>;
  getHolidayCalendar(year: number): Promise<readonly GreythrHoliday[]>;
  getApprovedLeave(cursor?: string, since?: Date): Promise<Page<GreythrLeave>>;
  getShiftAssignments(cursor?: string, since?: Date): Promise<Page<GreythrShiftAssignment>>;

  // Outbound
  checkAttendanceExists(greythrEmployeeId: string, date: string): Promise<AttendanceExistsResult>;
  postApprovedAttendance(records: readonly AttendanceExportRecord[]): Promise<BulkExportResult>;
}
