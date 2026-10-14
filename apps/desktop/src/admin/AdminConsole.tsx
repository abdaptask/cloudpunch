import { useState, type CSSProperties, type ReactNode } from 'react';
import { ReportingLines } from '../ReportingLines.js';
import { useTheme, type Theme } from '../ui/theme.js';
import { ComputersPage } from './ComputersPage.js';
import { ConnectionsPage } from './ConnectionsPage.js';
import { HolidaysPage } from './HolidaysPage.js';
import { PeopleTable } from './PeopleTable.js';
import { Reports } from './ReportsPage.js';
import { RulesPage } from './RulesPage.js';
import { ShiftsPage } from './ShiftsPage.js';
import { pickSection, sectionsFor, type SectionKey } from './sections.js';

/** The section last open, per computer (a convenience; may be unavailable). */
const REMEMBER_KEY = 'cloudpunch.admin.section';

function remembered(): string | null {
  try {
    return window.localStorage.getItem(REMEMBER_KEY);
  } catch {
    return null;
  }
}

/** `?section=` from the address (the day-end email links to Reports). */
function linkedSection(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('section');
  } catch {
    return null;
  }
}

function remember(key: SectionKey): void {
  try {
    window.localStorage.setItem(REMEMBER_KEY, key);
  } catch {
    // Storage blocked: the console still works, it just won't remember.
  }
}

/**
 * The admin console (ADR-0038 §1): a sidebar and a wide content area,
 * shown in the desktop's admin window and on the web at `/app/admin/`.
 * People is the table and panel (phase 3); the other sections are
 * today's screens until later phases replace them. The sidebar only offers what the capabilities allow; the
 * server checks every request again.
 */
export function AdminConsole({
  capabilities,
  onClose,
  height = '100vh',
}: {
  capabilities: readonly string[];
  /** The screens' "Done". */
  onClose: () => void;
  /** The whole window on the desktop; below the header on the web. */
  height?: string;
}): JSX.Element {
  const t = useTheme();
  const offered = sectionsFor(capabilities);
  const [chosen, setChosen] = useState<string | null>(() => linkedSection() ?? remembered());
  const section = pickSection(offered, chosen);
  // Rules with unsaved changes: leaving asks first (ADR-0038 §8).
  const [dirty, setDirty] = useState(false);
  const [leavingTo, setLeavingTo] = useState<SectionKey | null>(null);
  const go = (key: SectionKey): void => {
    setChosen(key);
    remember(key);
    setDirty(false);
    setLeavingTo(null);
  };
  const choose = (key: SectionKey): void => {
    if (key === section) return;
    if (dirty) setLeavingTo(key);
    else go(key);
  };
  const has = (c: string): boolean => capabilities.includes(c);

  const content = (key: SectionKey): ReactNode => {
    switch (key) {
      case 'people':
        return (
          <PeopleTable
            canAssignAll={has('admin.role.assign')}
            canSignOutMachines={has('admin.device.revoke')}
            onClose={onClose}
          />
        );
      // Each of these is the whole page here, so its list starts open.
      case 'managers':
        return <ReportingLines defaultOpen />;
      case 'shifts':
        return <ShiftsPage />;
      case 'holidays':
        return <HolidaysPage />;
      case 'rules':
        return <RulesPage canEditCompany={has('admin.policy.write')} onDirtyChange={setDirty} />;
      case 'computers':
        return <ComputersPage />;
      case 'connections':
        return <ConnectionsPage />;
      case 'reports':
        return <Reports canOpenDays={has('team.timeline.read')} />;
    }
  };

  return (
    <div style={{ display: 'flex', height, background: t.bg, color: t.text }}>
      <nav aria-label="admin-sections" style={sidebar(t)}>
        <div style={{ padding: '4px 12px 14px' }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>CloudPunch</div>
          <div style={{ fontSize: 12, color: t.muted }}>Admin</div>
        </div>
        {offered.map((s) => (
          <button
            key={s.key}
            type="button"
            aria-current={s.key === section ? 'page' : undefined}
            onClick={() => choose(s.key)}
            style={item(t, s.key === section)}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <main aria-label="admin-content" style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
        <div
          style={{
            // People is a table with a panel beside it: it takes the width.
            maxWidth:
              section === 'people' || section === 'connections' || section === 'reports'
                ? 1400
                : section === 'shifts'
                  ? 1100
                  : 960,
            padding: '20px 28px 40px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          {leavingTo !== null && (
            <div
              role="alertdialog"
              aria-label="leave-with-changes"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: 10,
                borderRadius: 10,
                background: t.warnBg,
                color: t.warnText,
                fontSize: 13,
              }}
            >
              <span style={{ flex: 1 }}>Rules has unsaved changes. Leave without saving?</span>
              <button type="button" onClick={() => go(leavingTo)} style={item(t, false)}>
                Leave
              </button>
              <button type="button" onClick={() => setLeavingTo(null)} style={item(t, true)}>
                Stay
              </button>
            </div>
          )}
          {section === null ? (
            <p style={{ margin: 0, fontSize: 13, color: t.muted }}>
              Your CloudPunch role has no admin screens.
            </p>
          ) : (
            content(section)
          )}
        </div>
      </main>
    </div>
  );
}

function sidebar(t: Theme): CSSProperties {
  return {
    width: 200,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '16px 8px',
    borderRight: `1px solid ${t.border}`,
    background: t.surface,
    overflowY: 'auto',
  };
}

function item(t: Theme, on: boolean): CSSProperties {
  return {
    textAlign: 'left',
    padding: '8px 12px',
    border: 'none',
    borderLeft: `3px solid ${on ? t.accent : 'transparent'}`,
    borderRadius: 6,
    background: on ? t.surfaceAlt : 'transparent',
    color: on ? t.text : t.muted,
    font: 'inherit',
    fontSize: 13,
    fontWeight: on ? 650 : 500,
    cursor: 'pointer',
  };
}
