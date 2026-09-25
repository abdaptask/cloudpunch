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
