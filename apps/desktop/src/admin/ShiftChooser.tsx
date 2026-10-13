import { useState, type CSSProperties } from 'react';
import { api, type Shift, type ShiftTemplate } from '../api.js';
import { ShiftForm, shiftText } from '../ShiftEditor.js';
import { Button } from '../ui/Button.js';
import { useTheme, type Theme } from '../ui/theme.js';

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  sign_in_again: 'Your sign-in has expired. Sign in again to see this.',
  forbidden: 'Only an Administrator can set shifts.',
  past_date: 'A shift can change from today on, not before.',
  template_retired: 'That named shift is retired.',
  template_not_found: 'That named shift no longer exists. Reload.',
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

const CUSTOM = 'custom';

/**
 * One person's shift in the person panel (ADR-0038 §6): a named shift by
 * name, from a date (today when left empty), or a custom pattern as
 * before.
 */
export function ShiftChooser({
  employeeId,
  name,
  shift,
  current,
  templates,
  onSaved,
  onCancel,
}: {
  employeeId: string;
  name: string;
  shift: Shift | null;
  /** The named shift they're on, if any. */
  current: { id: string; name: string } | null;
  /** Named shifts to offer; null when they couldn't be loaded. */
  templates: readonly ShiftTemplate[] | null;
  onSaved: (text: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useTheme();
  const offered = templates?.filter((x) => !x.retired) ?? [];
  // Their named shift, or "choose" — never stuck on Custom: the select stays.
  const [choice, setChoice] = useState<string>(
    current?.id ?? (offered.length > 0 || templates === null ? '' : CUSTOM),
  );
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const picked = offered.find((x) => x.id === choice);
  const save = (): void => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    api.adminSetNamedShift(employeeId, picked.id, from || null).then(
      (r) =>
        onSaved(
          `${name} is on ${picked.name}` + (from ? ` from ${r.effective_from}.` : ' from today.'),
        ),
      (e: unknown) => {
        setBusy(false);
        setError(errorText(String(e)));
      },
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <select
        aria-label={`shift for ${name}`}
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
        style={input(t)}
      >
        <option value="">Choose a named shift</option>
        {offered.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
        <option value={CUSTOM}>Custom pattern…</option>
      </select>
      {offered.length === 0 && (
        <span style={{ fontSize: 12, color: t.muted }}>
          {templates === null
            ? 'Named shifts are loading or unavailable; a custom pattern still works.'
            : 'No named shifts yet: set them up on the Shifts page.'}
        </span>
      )}
      {/* The select stays above, so switching back to a named shift is one click. */}
      {choice === CUSTOM && (
        <ShiftForm
          row={{ employee_id: employeeId, name, shift: current ? null : shift }}
          onCancel={onCancel}
          onSaved={(s) => onSaved(`Shift saved: ${shiftText(s)}.`)}
        />
      )}
      {picked && (
        <>
          <span style={{ fontSize: 12, color: t.muted }}>
            {shiftText({
              days: picked.days,
              start: picked.start,
              end: picked.end,
              tz_iana: picked.tz_iana,
            })}
          </span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
            From
            <input
              aria-label="shift-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              style={input(t)}
            />
            <span style={{ color: t.muted }}>{from ? '' : 'today'}</span>
          </label>
        </>
      )}
      {error && (
        <span role="alert" style={{ fontSize: 12, color: t.danger }}>
          {error}
        </span>
      )}
      {choice !== CUSTOM && (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            variant="primary"
            disabled={!picked || busy || (picked.id === current?.id && !from)}
            onClick={save}
          >
            Save shift
          </Button>
          <Button variant="chip" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
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
