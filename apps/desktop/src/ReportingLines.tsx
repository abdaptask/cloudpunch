import { useEffect, useState, type CSSProperties } from 'react';
import { api, type EmployeeRow } from './api.js';
import { useTheme, type Theme } from './ui/theme.js';

const ERROR_TEXT: Record<string, string> = {
  offline: "Can't reach CloudPunch right now.",
  forbidden: "Your role can't change reporting lines.",
  manager_loop: 'That would make a reporting loop.',
  self_manager: "Someone can't be their own manager.",
  manager_not_found: 'That manager is no longer active.',
};
const errorText = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

/**
 * Reporting lines (ADR-0025 §1), under People: who each person reports
 * to. A Manager sees their direct reports in the Team tab. The server
 * refuses loops and audits every change. greytHR takes this over later.
 */
export function ReportingLines(): JSX.Element {
  const t = useTheme();
  const [rows, setRows] = useState<EmployeeRow[] | null>(null);
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState<{ kind: 'error' | 'saved'; text: string } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    api.adminEmployees().then(
      (r) => {
        if (current) setRows(r.employees);
      },
      (e: unknown) => {
        if (current) setStatus({ kind: 'error', text: errorText(String(e)) });
      },
    );
    return () => {
      current = false;
    };
  }, []);

  const change = (row: EmployeeRow, managerId: string | null): void => {
    setSaving(row.id);
    setStatus(null);
    api.adminSetManager(row.id, managerId, reason).then(
      () => {
        setSaving(null);
        setRows((rs) =>
          rs
            ? rs.map((r) => (r.id === row.id ? { ...r, reporting_manager_id: managerId } : r))
            : rs,
        );
        const manager = rows?.find((r) => r.id === managerId)?.name;
        setStatus({
          kind: 'saved',
          text: manager
            ? `${row.name} now reports to ${manager}.`
            : `${row.name} has no manager now.`,
        });
      },
      (e: unknown) => {
        setSaving(null);
        setStatus({ kind: 'error', text: errorText(String(e)) });
      },
    );
  };

  return (
    <section
      aria-label="reporting-lines"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 12,
        border: `1px solid ${t.border}`,
        borderRadius: 12,
        background: t.surface,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 650 }}>Reporting lines</h3>
      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.4, color: t.muted }}>
        Who each person reports to. Managers see their direct reports in the Team tab.
      </p>
      <label
        style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: t.muted }}
      >
        Why (kept in the audit log, optional)
        <input
          aria-label="reporting-reason"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          style={input(t)}
        />
      </label>
      {!rows && !status && <span style={{ fontSize: 13, color: t.muted }}>Loading…</span>}
      {rows?.map((row) => (
        <label key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <span style={{ flex: 1, minWidth: 0 }}>{row.name}</span>
          <select
            aria-label={`manager of ${row.name}`}
            value={row.reporting_manager_id ?? ''}
            disabled={saving === row.id}
            onChange={(e) => change(row, e.target.value || null)}
            style={{ ...input(t), maxWidth: 180 }}
          >
            <option value="">No manager</option>
            {rows
              .filter((m) => m.id !== row.id)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </select>
        </label>
      ))}
      {status && (
        <p
          role={status.kind === 'error' ? 'alert' : 'status'}
          style={{ margin: 0, fontSize: 13, color: status.kind === 'error' ? t.danger : t.text }}
        >
          {status.text}
        </p>
      )}
    </section>
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
