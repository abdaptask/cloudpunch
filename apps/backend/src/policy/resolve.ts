import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { canonicalize } from '@cloudpunch/event-schema';
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';

/**
 * Policy resolution (ADR-0015 §2): schema defaults, then the global,
 * department and employee overrides, deep-merged per leaf setting
 * (most specific wins), validated against
 * `packages/policy-schema/idle-policy.schema.json` — the single source
 * of truth for settings, ranges and defaults.
 */

export type PolicyDocument = Record<string, unknown>;

interface SchemaNode {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  default?: unknown;
}

const require = createRequire(import.meta.url);
export const POLICY_SCHEMA =
  require('@cloudpunch/policy-schema/idle-policy.schema.json') as SchemaNode &
    Record<string, unknown>;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(POLICY_SCHEMA);

export class PolicyInvalidError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`policy is invalid: ${issues.join('; ')}`);
    this.name = 'PolicyInvalidError';
  }
}

/** Human-readable problems, or none if `doc` is a valid (partial) policy. */
export function policyIssues(doc: unknown): string[] {
  if (validate(doc)) return [];
  return (validate.errors ?? []).map(describe);
}

function describe(e: ErrorObject): string {
  const at = e.instancePath || '/';
  if (e.keyword === 'additionalProperties') {
    return `${at}: unknown setting "${String(e.params['additionalProperty'])}"`;
  }
  return `${at}: ${e.message ?? e.keyword}`;
}

/** Every default the schema declares, as one full policy document. */
export function schemaDefaults(node: SchemaNode = POLICY_SCHEMA): PolicyDocument {
  const out: PolicyDocument = {};
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    if ('default' in child) {
      out[key] = structuredClone(child.default);
    } else if (child.properties) {
      const nested = schemaDefaults(child);
      if (Object.keys(nested).length > 0) out[key] = nested;
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is PolicyDocument {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `over` on top of `base`: objects merge key by key; arrays, scalars
 * and `null` replace (a list setting is overridden as a whole).
 */
export function mergePolicy(base: PolicyDocument, over: PolicyDocument): PolicyDocument {
  const out: PolicyDocument = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const prior = out[key];
    out[key] =
      isPlainObject(prior) && isPlainObject(value)
        ? mergePolicy(prior, value)
        : structuredClone(value);
  }
  return out;
}

/** Defaults, then each layer in order (least to most specific). */
export function resolvePolicy(layers: readonly PolicyDocument[]): PolicyDocument {
  const merged = layers.reduce((acc, layer) => mergePolicy(acc, layer), schemaDefaults());
  const issues = policyIssues(merged);
  if (issues.length > 0) throw new PolicyInvalidError(issues);
  return merged;
}

/** Content version: `sha256-<hex>` of the canonical JSON (ADR-0015 §2). */
export function policyVersion(doc: PolicyDocument): string {
  const digest = createHash('sha256').update(canonicalize(doc)).digest('hex');
  return `sha256-${digest}`;
}
