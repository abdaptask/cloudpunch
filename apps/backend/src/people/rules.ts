import { AppRole, Capability, hasCapability } from '@cloudpunch/shared';

/**
 * Who may change which CloudPunch roles in-app (ADR-0020 §3). Pure.
 *
 * - An Administrator (`admin.role.assign`) may change any role.
 * - HR (`hr.employee.write`) may add or remove **Employee** and
 *   **Manager** only, never HR, Payroll, Auditor or Administrator.
 * - Nobody removes their own Administrator role, and the last
 *   Administrator can't be removed: no locking everyone out.
 *
 * Microsoft Graph checks the caller's own directory rights too; these
 * rules are CloudPunch's, on top.
 */

export const HR_ASSIGNABLE: readonly AppRole[] = [AppRole.Employee, AppRole.Manager];

export type RoleChangeRefusal =
  'not_allowed_for_role' | 'cannot_remove_own_admin' | 'last_administrator';

export interface RoleDiff {
  add: AppRole[];
  remove: AppRole[];
}

export function diffRoles(current: readonly AppRole[], wanted: readonly AppRole[]): RoleDiff {
  return {
    add: wanted.filter((r) => !current.includes(r)),
    remove: current.filter((r) => !wanted.includes(r)),
  };
}

export function checkRoleChange(input: {
  callerRoles: readonly AppRole[];
  callerOid: string;
  targetOid: string;
  diff: RoleDiff;
  /** Users holding Administrator now. */
  administrators: readonly string[];
}): RoleChangeRefusal | null {
  const { diff } = input;
  const isAdmin = hasCapability(input.callerRoles, Capability.AdminEmployeeAssignRole);
  const touched = [...diff.add, ...diff.remove];
  if (!isAdmin && touched.some((r) => !HR_ASSIGNABLE.includes(r))) return 'not_allowed_for_role';
  if (diff.remove.includes(AppRole.Administrator)) {
    if (input.targetOid === input.callerOid) return 'cannot_remove_own_admin';
    const others = input.administrators.filter((o) => o !== input.targetOid);
    if (others.length === 0) return 'last_administrator';
  }
  return null;
}
