import { AppRole } from './roles.js';

/**
 * Capability identifiers. Each protected backend route registers the
 * exact capability(ies) it requires; the guard middleware checks that
 * the caller's effective capability set (union across their App Roles)
 * contains one of the required entries.
 *
 * Values are stable strings (grouped by resource for readability) and
 * MUST NOT be renamed without a coordinated migration.
 */
export const Capability = {
  // Self — every employee can act on their own record
  SelfClockWrite: 'self.clock.write',
  SelfTimelineRead: 'self.timeline.read',
  SelfTimesheetRead: 'self.timesheet.read',
  SelfTimesheetCertify: 'self.timesheet.certify',
  SelfCorrectionRequest: 'self.correction.request',
  SelfPrivacyExport: 'self.privacy.export',

  // Team — managers on assigned team only, enforced server-side
  TeamTimelineRead: 'team.timeline.read',
  TeamTimesheetRead: 'team.timesheet.read',
  TeamTimesheetApprove: 'team.timesheet.approve',
  TeamCorrectionReview: 'team.correction.review',
  TeamReviewCaseRead: 'team.review_case.read',

  // HR — cross-team read + limited writes
  HrEmployeeRead: 'hr.employee.read',
  HrEmployeeWrite: 'hr.employee.write',
  HrDepartmentWrite: 'hr.department.write',
  HrOverrideWrite: 'hr.override.write',

  // Admin — full config + operational surface
  AdminConfigWrite: 'admin.config.write',
  AdminEmployeeAssignRole: 'admin.role.assign',
  AdminDeviceRevoke: 'admin.device.revoke',
  AdminIntegrationConfigure: 'admin.integration.configure',
  AdminReconciliationAct: 'admin.reconciliation.act',
  AdminPolicyWrite: 'admin.policy.write',

  // Payroll — read-only access to approved records + export
  PayrollApprovedRead: 'payroll.approved.read',
  PayrollExport: 'payroll.export',
  PayrollPeriodLockToggle: 'payroll.period.lock',

  // Auditor — read-only across everything, no write authority
  AuditReadAll: 'audit.read.all',
  AuditReadEvents: 'audit.read.events',
} as const;

export type Capability = (typeof Capability)[keyof typeof Capability];

/**
 * Role → capabilities. Additive: a user's effective capability set is
 * the union across every assigned role's capabilities.
 *
 * RBAC contract:
 *   - `Employee` is a base role granted to every provisioned user.
 *   - `Manager`, `HR`, `Payroll`, `Auditor` are additive.
 *   - `Administrator` is powerful for CONFIG but deliberately does NOT
 *     include Payroll or Auditor capabilities (separation of duties).
 *     Combining them requires explicit multi-role assignment in Entra
 *     and is treated as a sensitive event in the audit log.
 */
const _ROLE_CAPABILITIES: { readonly [K in AppRole]: readonly Capability[] } = {
  [AppRole.Employee]: [
    Capability.SelfClockWrite,
    Capability.SelfTimelineRead,
    Capability.SelfTimesheetRead,
    Capability.SelfTimesheetCertify,
    Capability.SelfCorrectionRequest,
    Capability.SelfPrivacyExport,
  ],
  [AppRole.Manager]: [
    Capability.TeamTimelineRead,
    Capability.TeamTimesheetRead,
    Capability.TeamTimesheetApprove,
    Capability.TeamCorrectionReview,
    Capability.TeamReviewCaseRead,
  ],
  [AppRole.HR]: [
    Capability.HrEmployeeRead,
    Capability.HrEmployeeWrite,
    Capability.HrDepartmentWrite,
    Capability.HrOverrideWrite,
    // HR has team-visibility across the org
    Capability.TeamTimelineRead,
    Capability.TeamTimesheetRead,
    Capability.TeamCorrectionReview,
  ],
  [AppRole.Administrator]: [
    Capability.AdminConfigWrite,
    Capability.AdminEmployeeAssignRole,
    Capability.AdminDeviceRevoke,
    Capability.AdminIntegrationConfigure,
    Capability.AdminReconciliationAct,
    Capability.AdminPolicyWrite,
    // Admin can also manage employees (HR-adjacent config)
    Capability.HrEmployeeRead,
    Capability.HrEmployeeWrite,
    Capability.HrDepartmentWrite,
    Capability.HrOverrideWrite,
  ],
  [AppRole.Payroll]: [
    Capability.PayrollApprovedRead,
    Capability.PayrollExport,
    Capability.PayrollPeriodLockToggle,
  ],
  [AppRole.Auditor]: [
    Capability.AuditReadAll,
    Capability.AuditReadEvents,
  ],
};

// Freeze arrays and outer object; expose the frozen view only.
for (const role of Object.keys(_ROLE_CAPABILITIES) as AppRole[]) {
  Object.freeze(_ROLE_CAPABILITIES[role]);
}
export const ROLE_CAPABILITIES = Object.freeze(_ROLE_CAPABILITIES);

/**
 * Compute the union of capabilities granted by a set of roles.
 * Returns a frozen Set for defensive callers.
 */
export function capabilitiesForRoles(roles: readonly AppRole[]): ReadonlySet<Capability> {
  const set = new Set<Capability>();
  for (const role of roles) {
    for (const cap of ROLE_CAPABILITIES[role]) {
      set.add(cap);
    }
  }
  return set;
}

/**
 * Fast check: does any assigned role grant the required capability?
 */
export function hasCapability(roles: readonly AppRole[], required: Capability): boolean {
  for (const role of roles) {
    if (ROLE_CAPABILITIES[role].includes(required)) return true;
  }
  return false;
}

/**
 * Fast check: does any assigned role grant ANY of the required
 * capabilities? Use when a route accepts several alternative authorizations.
 */
export function hasAnyCapability(
  roles: readonly AppRole[],
  required: readonly Capability[],
): boolean {
  for (const role of roles) {
    for (const cap of required) {
      if (ROLE_CAPABILITIES[role].includes(cap)) return true;
    }
  }
  return false;
}
