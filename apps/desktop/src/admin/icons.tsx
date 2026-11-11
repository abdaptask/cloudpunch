import type { ReactNode } from 'react';

/**
 * Small line icons for the People table (ADR-0054), drawn here: no icon
 * package, and inline SVG passes the CSP. 24×24 grid, stroke in the
 * current colour, so each takes the colour of its button.
 */
function Icon({ size = 16, children }: { size?: number; children: ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const SearchIcon = (): JSX.Element => (
  <Icon>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </Icon>
);

/** Reset filters: an arrow turning back. */
export const ResetIcon = (): JSX.Element => (
  <Icon>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </Icon>
);

/** Reload: two arrows in a circle. */
export const RefreshIcon = (): JSX.Element => (
  <Icon>
    <path d="M21 12a9 9 0 0 0-15.5-6.2L3 8" />
    <path d="M3 3v5h5" />
    <path d="M3 12a9 9 0 0 0 15.5 6.2L21 16" />
    <path d="M21 21v-5h-5" />
  </Icon>
);

/** Roles. */
export const KeyIcon = (): JSX.Element => (
  <Icon>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="M10.7 12.3L21 2" />
    <path d="M16 7l3 3" />
    <path d="M19 4l2 2" />
  </Icon>
);

/** History: a clock with a turning arrow. */
export const HistoryIcon = (): JSX.Element => (
  <Icon>
    <path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l3 2" />
  </Icon>
);

export const MailIcon = (): JSX.Element => (
  <Icon>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 7l9 6 9-6" />
  </Icon>
);

/** Deactivate: a person with a cross. */
export const UserXIcon = (): JSX.Element => (
  <Icon>
    <circle cx="9" cy="8" r="4" />
    <path d="M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1" />
    <path d="M17 8l5 5" />
    <path d="M22 8l-5 5" />
  </Icon>
);

/** Reactivate: a person with a tick. */
export const UserCheckIcon = (): JSX.Element => (
  <Icon>
    <circle cx="9" cy="8" r="4" />
    <path d="M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1" />
    <path d="M16 11l2 2 4-4" />
  </Icon>
);

/** Tell manager (ADR-0055): a speech bubble. */
export const MessageIcon = (): JSX.Element => (
  <Icon>
    <path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z" />
    <path d="M8.5 12h.01M12 12h.01M15.5 12h.01" />
  </Icon>
);

/** Something needs doing (no manager, no shift…). */
export const AlertIcon = (): JSX.Element => (
  <Icon size={14}>
    <path d="M12 3l9.5 17h-19z" />
    <path d="M12 10v4" />
    <path d="M12 17.5v.01" />
  </Icon>
);
