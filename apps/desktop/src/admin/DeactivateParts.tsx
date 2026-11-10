import { useRef, useState, type CSSProperties } from 'react';
import { api, type DeactivateOutcome, type DeactivateTarget } from '../api.js';
import { Button } from '../ui/Button.js';
import { useTheme, type Theme } from '../ui/theme.js';
import { ERROR_TEXT, HR_ASSIGNABLE } from './peopleParts.js';
import { namesText, type PersonRow } from './peopleModel.js';

/**
 * Deactivate (ADR-0052): one step that signs the person out and closes
 * any open session, removes their CloudPunch roles in Entra, turns
 * their record off and clears them as manager. A reason is required.
 * The answer is shown above the table (`DeactivatedNotice`), since the
 * person leaves the list once they're off.
 */

/** Administrators: anyone. HR: people with Employee/Manager roles only. */
export function canDeactivate(row: PersonRow, canAssignAll: boolean): boolean {
  if (!row.active) return false;
  if (row.employeeId === null && row.roles.length === 0) return false;
  return canAssignAll || row.roles.every((r) => HR_ASSIGNABLE.includes(r));
}

/** What happened, kept with the names the table knew. */
export interface Deactivated {
  reason: string;
  results: (DeactivateOutcome & { name: string })[];
}

const WHY: Record<string, string> = {
  cannot_deactivate_self: "you can't deactivate yourself",
  not_allowed_for_role: 'HR can deactivate Employee and Manager only',
  last_administrator: 'would leave no Administrator',
  person_mismatch: 'the record and Microsoft account are different people',
  unknown_person: 'no longer found',
  directory_not_configured: "Microsoft Entra isn't set up on the server",
  consent_required: 'Microsoft Entra needs admin consent',
  not_permitted: 'Microsoft refused',
  unavailable: "Microsoft Entra couldn't be reached",
  directory_forbidden: 'Microsoft refused',
  directory_error: 'Microsoft had a problem',
};
const why = (code: string | undefined): string =>
  (code && (WHY[code] ?? ERROR_TEXT[code])) ?? `something went wrong (${code ?? 'unknown'})`;

const MORE_ERRORS: Record<string, string> = {
  idempotency_key_reused: 'That was already sent differently. Close this and try again.',
  validation: 'A reason of at least 3 characters is needed.',
};
const errorText = (code: string): string =>
  MORE_ERRORS[code] ?? WHY[code] ?? ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

const targetOf = (r: { oid: string | null; employee_id: string | null }): DeactivateTarget => ({
  ...(r.oid ? { oid: r.oid } : {}),
  ...(r.employee_id ? { employee_id: r.employee_id } : {}),
});

const WHAT_HAPPENS =
  'This signs them out of CloudPunch on their computer and closes any open session, removes ' +
  'their CloudPunch roles in Microsoft Entra, turns their record off (no more emails; they ' +
  'leave Team and Reporting lines) and clears them as manager for anyone who reports to them. ' +
  'Their time history is kept.';

/** Confirm with a reason, then deactivate. Used by both panels. */
function Confirm({
  title,
  confirmLabel,
  disabled = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  confirmLabel: string;
  disabled?: boolean;
  onConfirm: (reason: string) => Promise<void>;
  onCancel?: () => void;
}): JSX.Element {
  const t = useTheme();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = reason.trim().length >= 3;
  return (
    <div role="group" aria-label="deactivate-confirm" style={box(t)}>
      <strong style={{ fontSize: 13 }}>{title}</strong>
      <span style={{ fontSize: 12.5, lineHeight: 1.45 }}>{WHAT_HAPPENS}</span>
      <textarea
        aria-label="deactivate-reason"
        placeholder="Reason (required, for the audit log)"
        value={reason}
        maxLength={500}
        rows={2}
        onChange={(e) => setReason(e.target.value)}
        style={input(t)}
      />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button
          variant="stop"
          disabled={!ok || busy || disabled}
          onClick={() => {
            setBusy(true);
            setError(null);
            onConfirm(reason.trim()).then(
              () => setBusy(false),
              (e: unknown) => {
                setBusy(false);
                setError(errorText(String(e)));
              },
            );
          }}
        >
          {busy ? 'Deactivating…' : confirmLabel}
        </Button>
        {onCancel && (
          <Button variant="secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 12.5, color: t.danger }}>
          {error}
        </p>
      )}
    </div>
  );
}

/** The person panel's Deactivate button (ADR-0052). */
export function DeactivatePart({
  row,
  onDone,
  startAsking = false,
}: {
  row: PersonRow;
  onDone: (d: Deactivated) => void;
  /** Opened from the table's Deactivate icon: straight to the confirmation. */
  startAsking?: boolean;
}): JSX.Element {
  const t = useTheme();
  const [asking, setAsking] = useState(startAsking);
  if (!asking) {
    return (
      <Button
        variant="stopOutline"
        onClick={() => setAsking(true)}
        style={{ alignSelf: 'flex-start', width: 'auto' }}
      >
        Deactivate…
      </Button>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, color: t.text }}>
      <Confirm
        title={`Deactivate ${row.name}?`}
        confirmLabel={`Deactivate ${row.name}`}
        onCancel={() => setAsking(false)}
        onConfirm={async (reason) => {
          const r = await api.adminDeactivate(
            targetOf({ oid: row.oid, employee_id: row.employeeId }),
            reason,
          );
          onDone({ reason, results: [{ ...r, name: row.name }] });
        }}
      />
    </div>
  );
}

/** "Deactivate selected" (ADR-0052 §5): the bulk panel for it. */
export function DeactivateBulkPanel({
  picked,
  canAssignAll,
  onDone,
  onClose,
}: {
  picked: readonly PersonRow[];
  canAssignAll: boolean;
  onDone: (d: Deactivated) => void;
  onClose: () => void;
}): JSX.Element {
  const t = useTheme();
  const go = picked.filter((r) => canDeactivate(r, canAssignAll));
  const left = picked.filter((r) => !canDeactivate(r, canAssignAll));
  // One key per distinct request: retrying after a lost answer reuses it.
  const keyed = useRef<{ request: string; key: string } | null>(null);
  const keyFor = (request: unknown): string => {
    const r = JSON.stringify(request);
    if (keyed.current?.request !== r) keyed.current = { request: r, key: crypto.randomUUID() };
    return keyed.current.key;
  };
  return (
    <aside aria-label="bulk Deactivate" style={panel(t)}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, fontSize: 15, fontWeight: 650 }}>
          Deactivate · {go.length} {go.length === 1 ? 'person' : 'people'}
        </div>
        <button type="button" aria-label="Close" onClick={onClose} style={link(t)}>
          ✕
        </button>
      </div>
      {go.length > 0 && <span style={{ fontSize: 12.5, lineHeight: 1.45 }}>{namesText(go)}</span>}
      {left.length > 0 && (
        <span style={{ fontSize: 12.5, color: t.muted }}>
          Left out: {namesText(left)} (
          {canAssignAll ? 'nothing to deactivate' : 'only an Administrator can'}).
        </span>
      )}
      <Confirm
        title={`Deactivate ${go.length} ${go.length === 1 ? 'person' : 'people'}?`}
        confirmLabel="Deactivate selected"
        disabled={go.length === 0}
        onConfirm={async (reason) => {
          const people = go.map((r) => targetOf({ oid: r.oid, employee_id: r.employeeId }));
          const res = await api.adminBulkDeactivate(keyFor([people, reason]), people, reason);
          onDone({
            reason,
            results: res.results.map((o, i) => ({ ...o, name: go[i]?.name ?? o.oid ?? '' })),
          });
        }}
      />
    </aside>
  );
}

/**
 * The answer, above the table: who's off, who wasn't and why, roles
 * still in Entra (with Retry), and who needs a new manager now (each a
 * link to their panel).
 */
export function DeactivatedNotice({
  value,
  rows,
  onOpen,
  onChange,
  onClose,
}: {
  value: Deactivated;
  rows: readonly PersonRow[];
  onOpen: (key: string) => void;
  onChange: (d: Deactivated) => void;
  onClose: () => void;
}): JSX.Element {
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = value.results;
  const off = r.filter((o) => o.outcome === 'done');
  const already = r.filter((o) => o.outcome === 'already');
  const not = r.filter((o) => o.outcome === 'refused' || o.outcome === 'failed');
  const entraLeft = r.filter((o) => o.entra === 'failed');
  const machines = off.reduce((n, o) => n + (o.devices_signed_out ?? 0), 0);
  const sessions = off.filter((o) => o.closed_at).length;
  const orphans = new Map<string, string>();
  for (const o of r) for (const u of o.unassigned_reports ?? []) orphans.set(u.id, u.name);
  const names = (xs: readonly { name: string }[]): string => xs.map((x) => x.name).join(', ');

  const retry = (): void => {
    setBusy(true);
    setError(null);
    Promise.all(
      entraLeft.map((o) =>
        api.adminDeactivate(targetOf(o), value.reason).then((n) => ({ ...n, name: o.name })),
      ),
    ).then(
      (again) => {
        setBusy(false);
        const by = new Map(again.map((n) => [n.oid ?? n.employee_id, n]));
        onChange({
          ...value,
          results: r.map((o) => {
            const n = by.get(o.oid ?? o.employee_id);
            // Keep what the first run did; take the new Entra answer.
            if (!n) return o;
            const kept = { ...o };
            delete kept.entra_code;
            return {
              ...kept,
              ...(n.entra ? { entra: n.entra } : {}),
              ...(n.entra_code ? { entra_code: n.entra_code } : {}),
            };
          }),
        });
      },
      (e: unknown) => {
        setBusy(false);
        setError(errorText(String(e)));
      },
    );
  };

  return (
    <div role="status" aria-label="deactivated" style={box(t)}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {off.length > 0 && (
            <span>
              <strong>Deactivated: {names(off)}.</strong>{' '}
              {machines > 0
                ? `Signed out of ${machines} ${machines === 1 ? 'computer' : 'computers'}`
                : 'No computer to sign out'}
              {sessions > 0 &&
                `; ${sessions} open ${sessions === 1 ? 'session' : 'sessions'} closed at the last activity`}
              . Their time history is kept.
            </span>
          )}
          {already.length > 0 && <span>Already deactivated: {names(already)}.</span>}
          {not.length > 0 && (
            <span style={{ color: t.danger }}>
              Not deactivated: {not.map((o) => `${o.name} (${why(o.code)})`).join('; ')}.
            </span>
          )}
          {entraLeft.length > 0 && (
            <span style={{ color: t.warnText }}>
              Their CloudPunch roles are still in Microsoft Entra for {names(entraLeft)} (
              {why(entraLeft[0]?.entra_code)}). They can&apos;t clock in or upload either way.{' '}
              <button type="button" disabled={busy} onClick={retry} style={link(t)}>
                {busy ? 'Retrying…' : 'Retry removing roles'}
              </button>
            </span>
          )}
          {orphans.size > 0 && (
            <span>
              <strong>Needs a new manager:</strong>{' '}
              {[...orphans].map(([id, name], i) => {
                const row = rows.find((x) => x.employeeId === id);
                return (
                  <span key={id}>
                    {i > 0 && ', '}
                    {row ? (
                      <button type="button" onClick={() => onOpen(row.key)} style={link(t)}>
                        {name}
                      </button>
                    ) : (
                      name
                    )}
                  </span>
                );
              })}
            </span>
          )}
          {error && (
            <span role="alert" style={{ color: t.danger }}>
              {error}
            </span>
          )}
        </div>
        <button type="button" aria-label="Dismiss" onClick={onClose} style={link(t)}>
          ✕
        </button>
      </div>
    </div>
  );
}

function box(t: Theme): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 10,
    borderRadius: 10,
    border: `1px solid ${t.border}`,
    background: t.surfaceAlt,
    fontSize: 12.5,
    lineHeight: 1.45,
  };
}

function panel(t: Theme): CSSProperties {
  return {
    flex: '0 1 320px',
    minWidth: 0,
    maxWidth: '100%',
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
    resize: 'vertical',
  };
}

function link(t: Theme): CSSProperties {
  return {
    padding: 0,
    border: 'none',
    background: 'none',
    color: t.accent,
    font: 'inherit',
    fontSize: 12.5,
    cursor: 'pointer',
  };
}
