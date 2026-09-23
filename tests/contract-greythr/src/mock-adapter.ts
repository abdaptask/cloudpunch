import type {
  AttendanceExistsResult,
  AttendanceExportRecord,
  BulkExportResult,
  BulkExportResultItem,
  CapabilitySet,
  GreythrAdapter,
  GreythrEmployee,
  GreythrHoliday,
  GreythrLeave,
  GreythrShiftAssignment,
  HealthProbeResult,
  Page,
} from '@cloudpunch/shared';

export interface MockAdapterOptions {
  employees?: readonly GreythrEmployee[];
  holidays?: readonly GreythrHoliday[];
  leave?: readonly GreythrLeave[];
  shiftAssignments?: readonly GreythrShiftAssignment[];
  capabilities?: Partial<CapabilitySet>;
  /**
   * If set, `postApprovedAttendance` treats records whose idempotency
   * key appears here as duplicates and returns `duplicate_noop` for them
   * (with the pre-existing externalReferenceId).
   */
  existingAttendanceByKey?: ReadonlyMap<string, string>;
}

const DEFAULT_CAPS: CapabilitySet = Object.freeze({
  readEmployees: false,
  readEmployeesDelta: false,
  readHolidays: false,
  readLeave: false,
  readShifts: false,
  writeAttendance: false,
  writeAttendanceCorrection: false,
  webhooksTermination: false,
});

/**
 * Deterministic in-memory GreythrAdapter for tests. Advertises no
 * capabilities by default — tests opt in explicitly. Every method that
 * is called without its capability advertised throws to catch drift.
 */
export class GreythrMockAdapter implements GreythrAdapter {
  private readonly employees: readonly GreythrEmployee[];
  private readonly holidays: readonly GreythrHoliday[];
  private readonly leave: readonly GreythrLeave[];
  private readonly shiftAssignments: readonly GreythrShiftAssignment[];
  private readonly capabilities: CapabilitySet;
  private readonly existingAttendanceByKey: ReadonlyMap<string, string>;
  public exportCalls: Array<readonly AttendanceExportRecord[]> = [];

  constructor(opts: MockAdapterOptions = {}) {
    this.employees = opts.employees ?? [];
    this.holidays = opts.holidays ?? [];
    this.leave = opts.leave ?? [];
    this.shiftAssignments = opts.shiftAssignments ?? [];
    this.capabilities = Object.freeze({ ...DEFAULT_CAPS, ...opts.capabilities });
    this.existingAttendanceByKey = opts.existingAttendanceByKey ?? new Map<string, string>();
  }

  // NB: every capability-gated method is `async` so that a
  // synchronous `throw` inside `requireCapability` becomes a rejected
  // Promise. Callers assert with `.rejects.toThrow(...)`.

  async ping(): Promise<HealthProbeResult> {
    return { ok: true, latencyMs: 1, detail: 'mock' };
  }

  describeCapabilities(): CapabilitySet {
    return this.capabilities;
  }

  async listActiveEmployees(_cursor?: string, since?: Date): Promise<Page<GreythrEmployee>> {
    this.requireCapability('readEmployees');
    if (since !== undefined) {
      this.requireCapability('readEmployeesDelta');
      // Mock has no per-row updatedAt; passing `since` filters nothing
      // in this simple mock but exercises the capability gate.
    }
    const items = this.employees.filter((e) => e.status === 'active');
    return { items, nextCursor: null };
  }

  async getEmployee(greythrEmployeeId: string): Promise<GreythrEmployee | null> {
    this.requireCapability('readEmployees');
    const match = this.employees.find((e) => e.greythrEmployeeId === greythrEmployeeId);
    return match ?? null;
  }

  async getHolidayCalendar(_year: number): Promise<readonly GreythrHoliday[]> {
    this.requireCapability('readHolidays');
    return this.holidays;
  }

  async getApprovedLeave(_cursor?: string, _since?: Date): Promise<Page<GreythrLeave>> {
    this.requireCapability('readLeave');
    return {
      items: this.leave.filter((l) => l.status === 'approved'),
      nextCursor: null,
    };
  }

  async getShiftAssignments(
    _cursor?: string,
    _since?: Date,
  ): Promise<Page<GreythrShiftAssignment>> {
    this.requireCapability('readShifts');
    return { items: this.shiftAssignments, nextCursor: null };
  }

  async checkAttendanceExists(
    _greythrEmployeeId: string,
    _date: string,
  ): Promise<AttendanceExistsResult> {
    this.requireCapability('writeAttendance');
    return { exists: false, externalReferenceId: null, idempotencyKey: null };
  }

  async postApprovedAttendance(
    records: readonly AttendanceExportRecord[],
  ): Promise<BulkExportResult> {
    this.requireCapability('writeAttendance');
    this.exportCalls.push(records);
    const items: BulkExportResultItem[] = records.map((r) => {
      const existing = this.existingAttendanceByKey.get(r.idempotencyKey);
      if (existing !== undefined) {
        return {
          idempotencyKey: r.idempotencyKey,
          status: 'duplicate_noop',
          externalReferenceId: existing,
          errorCode: null,
          errorMessage: null,
        };
      }
      return {
        idempotencyKey: r.idempotencyKey,
        status: 'accepted',
        externalReferenceId: `mock-${r.idempotencyKey.slice(0, 12)}`,
        errorCode: null,
        errorMessage: null,
      };
    });
    return { items };
  }

  // ---------------------------------------------------------------

  private requireCapability(cap: keyof CapabilitySet): void {
    if (!this.capabilities[cap]) {
      throw new Error(
        `GreythrMockAdapter: method requires capability '${cap}' but it is not advertised. ` +
          `Enable it via constructor: new GreythrMockAdapter({ capabilities: { ${cap}: true } }).`,
      );
    }
  }
}
