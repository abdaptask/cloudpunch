/**
 * Microsoft Entra ID App Role values assigned on the CloudPunch API app
 * registration. These strings appear in a token's `roles` claim and are
 * the authoritative RBAC identifiers.
 *
 * NEVER rename these values. Add new roles and deprecate old ones instead.
 * See ADR-0002 §2 and ADR-0002 §6 for assignment strategy.
 */
export const AppRole = {
  Employee: 'Employee',
  Manager: 'Manager',
  HR: 'HR',
  Administrator: 'Administrator',
  Payroll: 'Payroll',
  Auditor: 'Auditor',
} as const;

export type AppRole = (typeof AppRole)[keyof typeof AppRole];

export const ALL_APP_ROLES: readonly AppRole[] = Object.freeze(Object.values(AppRole) as AppRole[]);

/**
 * Type guard for validating an unknown value (e.g. a claim from a token)
 * before treating it as an AppRole.
 */
export function isAppRole(value: unknown): value is AppRole {
  return typeof value === 'string' && (ALL_APP_ROLES as readonly string[]).includes(value);
}

/**
 * Filter a raw claim array (from `roles`) down to recognized App Roles.
 * Unknown role names are dropped silently — the backend never trusts a
 * claim it did not itself register.
 */
export function filterKnownRoles(rawRoles: readonly unknown[]): readonly AppRole[] {
  const seen = new Set<AppRole>();
  for (const r of rawRoles) {
    if (isAppRole(r)) seen.add(r);
  }
  return Object.freeze(Array.from(seen));
}
