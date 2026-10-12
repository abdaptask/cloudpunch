import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, type BulkOutcome } from '../api.js';
import { ERROR_TEXT, HR_ASSIGNABLE, ROLES } from '../PeopleScreen.js';
import { Button } from '../ui/Button.js';
import { useTheme, type Theme } from '../ui/theme.js';
import { ManagerPicker } from './ManagerPicker.js';
import {
  MANAGING_ROLES,
  managerPlan,
  namesText,
  rolePlan,
  welcomePlan,
  type PersonRow,
} from './peopleModel.js';

export type BulkAction = 'manager' | 'addRole' | 'removeRole' | 'welcome';

export const BULK_LABEL: Record<BulkAction, string> = {
  manager: 'Set manager',
  addRole: 'Add role',
  removeRole: 'Remove role',
  welcome: 'Send welcome email',
};

const MORE_ERRORS: Record<string, string> = {
  idempotency_key_reused: 'That change was already made differently. Close this and try again.',
  unknown_people: 'Someone in the selection is no longer active. Reload and try again.',
  self_manager: "Someone can't be their own manager.",
  manager_loop: 'That would make a reporting loop.',
  manager_not_found: 'That manager is no longer active.',
  welcome_not_configured: 'Welcome emails are not set up on the server yet.',
  validation: 'The server refused this selection (at most 200 people).',
};
const errorText = (code: string): string =>
  MORE_ERRORS[code] ?? ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

/** Why one person wasn't changed. */
const OUTCOME_TEXT: Record<string, string> = {
  cannot_remove_own_admin: "can't remove your own Administrator role",
  not_allowed_for_role: 'not allowed for your role',
  last_administrator: 'would leave no Administrator',
  unknown_person: 'not in the directory',
  directory_forbidden: 'Microsoft refused',
  directory_error: 'Microsoft had a problem; try again',
  welcome_recently_sent: 'sent recently',
  no_email: 'no email address',
  welcome_send_failed: 'could not be sent; try again',
  welcome_not_permitted: 'the mailbox refused to send',
};

type Result =
  | { kind: 'manager'; changed: number; unchanged: number }
  | { kind: 'outcomes'; outcomes: BulkOutcome[] };

/**
 * A bulk change (ADR-0038 §5) for the ticked people: choose, see what
 * it would do, then Apply. Nothing is saved before Apply. Each request
 * has an idempotency key: retrying the same request after a lost answer
 * reuses it, so the server answers as it did and changes nothing twice.
 */
export function BulkPanel({
  action,
  picked,
  rows,
  canAssignAll,
  onChanged,
  onClose,
}: {
  action: BulkAction;
  picked: readonly PersonRow[];
  rows: readonly PersonRow[];
  canAssignAll: boolean;
  onChanged: () => void;
  onClose: () => void;
}): JSX.Element {
  const t = useTheme();
  // undefined: not chosen yet; null: "No manager".
  const [managerId, setManagerId] = useState<string | null | undefined>(undefined);
  const [role, setRole] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  // One key per distinct request: the same request again reuses it.
  const keyed = useRef<{ request: string; key: string } | null>(null);
  const keyFor = (request: unknown): string => {
    const r = JSON.stringify(request);
    if (keyed.current?.request !== r) keyed.current = { request: r, key: crypto.randomUUID() };
    return keyed.current.key;
  };
  const nameOf = (oid: string): string => rows.find((r) => r.oid === oid)?.name ?? oid;

  const run = <T,>(call: () => Promise<T>, done: (r: T) => Result): void => {
    setBusy(true);
    setError(null);
    call().then(
      (r) => {
        setBusy(false);
        setResult(done(r));
        onChanged();
      },
      (e: unknown) => {
        setBusy(false);
        setError(errorText(String(e)));
      },
    );
  };

  let body: ReactNode;
  let apply: (() => void) | null = null;

  if (action === 'manager') {
    const candidates = rows
      .filter(
        (r): r is PersonRow & { employeeId: string } =>
          r.employeeId !== null && MANAGING_ROLES.some((x) => r.roles.includes(x)),
      )
      .map((r) => ({ id: r.employeeId, name: r.name }));
    const current =
      managerId === undefined || managerId === null
        ? null
        : (candidates.find((c) => c.id === managerId) ?? null);
    const plan = managerId === undefined ? null : managerPlan(rows, picked, managerId);
    const who = current?.name;
    body = (
      <>
        {managerId === undefined ? (
          <ManagerPicker
            person={count(picked.length)}
            current={null}
            startOpen
            emptyText="No manager chosen"
            choices={candidates}
            onPick={(id) => setManagerId(id)}
          />
        ) : (
          <div style={{ display: 'flex', gap: 8, fontSize: 13 }}>
            <span style={{ flex: 1 }}>{who ? `New manager: ${who}` : 'No manager'}</span>
            <button type="button" onClick={() => setManagerId(undefined)} style={link(t)}>
              Change
            </button>
          </div>
        )}
        {managerId === undefined && (
          <button
            type="button"
            onClick={() => setManagerId(null)}
            style={{ ...link(t), alignSelf: 'flex-start', fontSize: 12.5 }}
          >
            Remove their manager instead
          </button>
        )}
        {plan && (
          <Preview t={t}>
            {plan.problem ? (
              <span style={{ color: t.danger }}>
                {plan.problem.code === 'self_manager'
                  ? `${plan.problem.who.name} is in the selection, and can't be their own manager.`
                  : `${plan.problem.who.name} is above ${who ?? 'them'}: that would make a reporting loop.`}
              </span>
            ) : (
              <>
                This changes {count(plan.change.length)}
                {plan.change.length > 0 &&
                  (who
                    ? `: ${namesText(plan.change)} ${one(plan.change.length, 'gets', 'get')} ${who} as manager`
                    : `: ${namesText(plan.change)} will have no manager`)}
                .
                {plan.already.length > 0 &&
                  ` ${count(plan.already.length)} already ${who ? `${one(plan.already.length, 'reports', 'report')} to ${who}` : `${one(plan.already.length, 'has', 'have')} no manager`}.`}
              </>
            )}
            {plan.skipped.length > 0 && (
              <Skipped
                t={t}
                rows={plan.skipped}
                why={['has no CloudPunch record', 'have no CloudPunch record']}
              />
            )}
          </Preview>
        )}
      </>
    );
    if (plan && !plan.problem && plan.change.length > 0) {
      const ids = plan.change.map((r) => r.employeeId as string);
      const m = managerId ?? null;
      apply = () =>
        run(
          () => api.adminBulkManager(keyFor(['manager', ids, m, text]), ids, m, text),
          (r) => ({ kind: 'manager', changed: r.changed.length, unchanged: r.unchanged.length }),
        );
    }
  } else if (action === 'addRole' || action === 'removeRole') {
    const add = action === 'addRole';
    const offered = ROLES.map(([r]) => r).filter((r) => canAssignAll || HR_ASSIGNABLE.includes(r));
    const plan = role ? rolePlan(picked, role, add) : null;
    body = (
      <>
        <select
          aria-label="bulk-role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          style={input(t)}
        >
          <option value="">Choose a role</option>
          {offered.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        {plan && (
          <Preview t={t}>
            This changes {count(plan.change.length)}
            {plan.change.length > 0 &&
              `: ${namesText(plan.change)} ${one(plan.change.length, add ? 'gets' : 'loses', add ? 'get' : 'lose')} ${role}`}
            .
            {plan.already.length > 0 &&
              ` ${count(plan.already.length)} ${add ? `already ${one(plan.already.length, 'has', 'have')} it` : `${one(plan.already.length, "doesn't", "don't")} have it`}.`}
            {plan.skipped.length > 0 && (
              <Skipped
                t={t}
                rows={plan.skipped}
                why={[
                  "isn't linked to a Microsoft account",
                  "aren't linked to a Microsoft account",
                ]}
              />
            )}
          </Preview>
        )}
      </>
    );
    if (plan && plan.change.length > 0) {
      const oids = plan.change.map((r) => r.oid as string);
      const change = add ? { add: [role], remove: [] } : { add: [], remove: [role] };
      apply = () =>
        run(
          () => api.adminBulkRoles(keyFor(['roles', oids, change, text]), oids, change, text),
          (r) => ({ kind: 'outcomes', outcomes: r.results }),
        );
    }
  } else {
    const plan = welcomePlan(picked);
    body = (
      <Preview t={t}>
        Sends the welcome email to {count(plan.send.length)}
        {plan.send.length > 0 && `: ${namesText(plan.send)}`}.
        {plan.skipped.length > 0 && (
          <Skipped
            t={t}
            rows={plan.skipped}
            why={["doesn't have the Employee role", "don't have the Employee role"]}
          />
        )}
      </Preview>
    );
    if (plan.send.length > 0) {
      const oids = plan.send.map((r) => r.oid as string);
      apply = () =>
        run(
          () => api.adminBulkWelcome(keyFor(['welcome', oids, text]), oids, text),
          (r) => ({ kind: 'outcomes', outcomes: r.results }),
        );
    }
  }

  return (
    <aside aria-label={`bulk ${BULK_LABEL[action]}`} style={panel(t)}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, fontSize: 15, fontWeight: 650 }}>
          {BULK_LABEL[action]} · {count(picked.length)}
        </div>
        <button type="button" aria-label="Close" onClick={onClose} style={link(t)}>
          ✕
        </button>
      </div>

      {result ? (
        <ResultView result={result} nameOf={nameOf} t={t} />
      ) : (
        <>
          {body}
          <input
            aria-label={action === 'welcome' ? 'bulk-note' : 'bulk-reason'}
            placeholder={
              action === 'welcome'
                ? 'A personal note at the top (optional)'
                : 'Why (audit log, optional)'
            }
            value={text}
            maxLength={500}
            onChange={(e) => setText(e.target.value)}
            style={input(t)}
          />
          <Button variant="primary" disabled={!apply || busy} onClick={() => apply?.()}>
            {busy ? 'Applying…' : 'Apply'}
          </Button>
          {error && (
            <p role="alert" style={{ margin: 0, fontSize: 12.5, color: t.danger }}>
              {error}
            </p>
          )}
        </>
      )}
    </aside>
  );
}

const count = (n: number): string => `${n} ${n === 1 ? 'person' : 'people'}`;
const one = (n: number, singular: string, plural: string): string => (n === 1 ? singular : plural);

function Preview({ t, children }: { t: Theme; children: ReactNode }): JSX.Element {
  return (
    <div
      role="status"
      aria-label="bulk-preview"
      style={{
        fontSize: 12.5,
        lineHeight: 1.45,
        padding: 10,
        borderRadius: 10,
        background: t.surfaceAlt,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <span>{children}</span>
    </div>
  );
}

function Skipped({
  t,
  rows,
  why,
}: {
  t: Theme;
  rows: readonly PersonRow[];
  /** Singular and plural. */
  why: [string, string];
}): JSX.Element {
  return (
    <span style={{ display: 'block', color: t.muted }}>
      Left out: {namesText(rows)} ({one(rows.length, ...why)}).
    </span>
  );
}

function ResultView({
  result,
  nameOf,
  t,
}: {
  result: Result;
  nameOf: (oid: string) => string;
  t: Theme;
}): JSX.Element {
  if (result.kind === 'manager') {
    return (
      <p role="status" style={{ margin: 0, fontSize: 13 }}>
        Done. {count(result.changed)} changed
        {result.unchanged > 0 && `; ${result.unchanged} already had that manager`}.
      </p>
    );
  }
  const ok = result.outcomes.filter((o) => o.outcome === 'done' || o.outcome === 'sent');
  const already = result.outcomes.filter((o) => o.outcome === 'already');
  const not = result.outcomes.filter((o) => o.outcome === 'refused' || o.outcome === 'failed');
  const freed = result.outcomes.flatMap((o) => o.unassigned_reports ?? []).map((x) => x.name);
  return (
    <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
      <span>
        Done: {count(ok.length)}
        {already.length > 0 && `; ${already.length} already were`}.
      </span>
      {not.length > 0 && (
        <>
          <span style={{ color: t.danger }}>Not done for {count(not.length)}:</span>
          <ul aria-label="bulk-not-done" style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
            {not.map((o) => (
              <li key={o.oid}>
                {nameOf(o.oid)}: {OUTCOME_TEXT[o.code ?? ''] ?? o.code ?? 'failed'}
              </li>
            ))}
          </ul>
        </>
      )}
      {freed.length > 0 && (
        <span style={{ color: t.warnText, fontSize: 12.5 }}>
          {freed.join(', ')} {freed.length === 1 ? 'has' : 'have'} no manager now.
        </span>
      )}
    </div>
  );
}

function panel(t: Theme): CSSProperties {
  return {
    width: 320,
    flexShrink: 0,
    alignSelf: 'flex-start',
    position: 'sticky',
    top: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: 14,
    border: `1px solid ${t.border}`,
    borderRadius: 12,
    background: t.surface,
    boxSizing: 'border-box',
  };
}

function input(t: Theme): CSSProperties {
  return {
    font: 'inherit',
    fontSize: 13,
    padding: '6px 8px',
    borderRadius: 8,
    border: `1px solid ${t.border}`,
    background: t.bg,
    color: t.text,
  };
}

function link(t: Theme): CSSProperties {
  return {
    padding: 0,
    border: 'none',
    background: 'none',
    color: t.accent,
    font: 'inherit',
    fontSize: 13,
    cursor: 'pointer',
  };
}
