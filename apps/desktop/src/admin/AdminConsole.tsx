import { useState, type CSSProperties, type ReactNode } from 'react';
import { EveryoneConnections } from '../ConnectionsView.js';
import { HolidayEditor } from '../HolidayEditor.js';
import { PeopleScreen } from '../PeopleScreen.js';
import { ReportingLines } from '../ReportingLines.js';
import { SettingsScreen } from '../SettingsScreen.js';
import { ShiftEditor } from '../ShiftEditor.js';
import { useTheme, type Theme } from '../ui/theme.js';
import { VersionsScreen } from '../VersionsScreen.js';
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

function remember(key: SectionKey): void {
  try {
    window.localStorage.setItem(REMEMBER_KEY, key);
  } catch {
    // Storage blocked: the console still works, it just won't remember.
  }
}

/**
 * The admin console (ADR-0038 §1): a sidebar and a wide content area,
 * shown in the desktop's admin window (and, later, on the web). Each
 * section is today's screen, unchanged; later phases replace them one
 * by one. The sidebar only offers what the capabilities allow; the
 * server checks every request again.
 */
export function AdminConsole({
  capabilities,
  onClose,
}: {
  capabilities: readonly string[];
  /** The screens' "Done". */
  onClose: () => void;
}): JSX.Element {
  const t = useTheme();
  const offered = sectionsFor(capabilities);
  const [chosen, setChosen] = useState<string | null>(remembered);
  const section = pickSection(offered, chosen);
  const choose = (key: SectionKey): void => {
    setChosen(key);
    remember(key);
  };
  const has = (c: string): boolean => capabilities.includes(c);

  const content = (key: SectionKey): ReactNode => {
    switch (key) {
      case 'people':
        return (
          <>
            <PeopleScreen
              canAssignAll={has('admin.role.assign')}
              canSignOutMachines={has('admin.device.revoke')}
              onClose={onClose}
            />
            <ReportingLines />
          </>
        );
      case 'shifts':
        return <ShiftEditor />;
      case 'holidays':
        return <HolidayEditor />;
      case 'rules':
        return <SettingsScreen canEditCompany={has('admin.policy.write')} onClose={onClose} />;
      case 'computers':
        return <VersionsScreen onClose={onClose} />;
      case 'connections':
        return <EveryoneConnections />;
    }
  };

  return (
    <div style={{ display: 'flex', height: '100vh', background: t.bg, color: t.text }}>
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
            maxWidth: 760,
            padding: '20px 28px 40px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
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
