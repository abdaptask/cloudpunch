import type { DbRepositories, Employee } from '../db/index.js';
import { policyVersion, resolvePolicy, type PolicyDocument } from './resolve.js';

export interface EffectivePolicy {
  version: string;
  policy: PolicyDocument;
}

/**
 * The policy in force for `employee`: defaults, then the global,
 * department and employee overrides (ADR-0015 §2). Throws
 * `PolicyInvalidError` if a stored override makes it invalid — never a
 * silent fallback to defaults.
 */
export async function effectivePolicyFor(
  db: DbRepositories,
  employee: Employee,
): Promise<EffectivePolicy> {
  const layers: PolicyDocument[] = [];
  const global = await db.policies.find('global', null);
  if (global) layers.push(global.document);
  if (employee.departmentId) {
    const dept = await db.policies.find('department', employee.departmentId);
    if (dept) layers.push(dept.document);
  }
  const own = await db.policies.find('employee', employee.id);
  if (own) layers.push(own.document);

  const policy = resolvePolicy(layers);
  return { version: policyVersion(policy), policy };
}

/**
 * What a scope's settings resolve to before anything narrower: defaults
 * and global for `global`; plus the department's override for a
 * department. The settings screen shows these as current values.
 */
export async function effectivePolicyForScope(
  db: DbRepositories,
  scope: 'global' | 'department',
  departmentId: string | null,
): Promise<EffectivePolicy> {
  const layers: PolicyDocument[] = [];
  const global = await db.policies.find('global', null);
  if (global) layers.push(global.document);
  if (scope === 'department' && departmentId) {
    const dept = await db.policies.find('department', departmentId);
    if (dept) layers.push(dept.document);
  }
  const policy = resolvePolicy(layers);
  return { version: policyVersion(policy), policy };
}
