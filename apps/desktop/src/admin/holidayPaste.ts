import type { Holiday } from '../api.js';

/** "Mon, 9 Nov 2026" for `2026-11-09`, whatever the computer's zone. */
export function holidayDateText(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * "Paste a list" for Holidays (ADR-0038 §9): one holiday per line, in
 * the ways people write them, checked before anything is saved. Pure.
 *
 *   26 Jan, Republic Day
 *   26 January 2027 - Republic Day
 *   2027-01-26 Republic Day
 *   Jan 26: Republic Day
 *
 * A date without a year is its next one on or after `today`.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export type PastedLine =
  | {
      line: number;
      text: string;
      date: string;
      name: string;
      /** New; a new name for a date already listed; or already exactly listed. */
      status: 'new' | 'rename' | 'same';
      /** The name it has now, when renamed. */
      was?: string;
    }
  | { line: number; text: string; status: 'invalid'; why: string };

const pad = (n: number): string => String(n).padStart(2, '0');

/** A real calendar date, or null. */
function dateOf(y: number, m: number, d: number): string | null {
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : null;
}

function monthOf(word: string): number | null {
  const i = MONTHS.indexOf(word.slice(0, 3).toLowerCase());
  return i < 0 ? null : i + 1;
}

/** The date at the start of `text` and the rest; null when there is none. */
function leadingDate(text: string, today: string): { date: string | null; rest: string } | null {
  const ty = Number(today.slice(0, 4));
  const withYear = (m: number, d: number, y: string | undefined): string | null => {
    if (y) return dateOf(Number(y), m, d);
    const thisYear = dateOf(ty, m, d);
    if (thisYear && thisYear >= today) return thisYear;
    return dateOf(ty + 1, m, d);
  };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})\b(.*)$/.exec(text);
  if (m) return { date: dateOf(Number(m[1]), Number(m[2]), Number(m[3])), rest: m[4] ?? '' };
  // 26 Jan [2027]
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?(?:,?\s+(\d{4}))?\b(.*)$/.exec(text);
  if (m) {
    const month = monthOf(m[2] ?? '');
    return month === null ? null : { date: withYear(month, Number(m[1]), m[3]), rest: m[4] ?? '' };
  }
  // Jan 26[, 2027]
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b(.*)$/.exec(text);
  if (m) {
    const month = monthOf(m[1] ?? '');
    return month === null ? null : { date: withYear(month, Number(m[2]), m[3]), rest: m[4] ?? '' };
  }
  return null;
}

/** Each non-empty line, read and compared with the holidays already listed. */
export function parseHolidayList(
  text: string,
  existing: readonly Holiday[],
  today: string,
): PastedLine[] {
  const out: PastedLine[] = [];
  const seen = new Map<string, string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const t = raw.trim();
    if (!t) return;
    const lead = leadingDate(t, today);
    if (!lead) {
      out.push({ line, text: t, status: 'invalid', why: 'No date at the start' });
      return;
    }
    if (!lead.date) {
      out.push({ line, text: t, status: 'invalid', why: 'Not a real date' });
      return;
    }
    const name = lead.rest.replace(/^[\s,:;–—-]+/, '').trim();
    if (!name) {
      out.push({ line, text: t, status: 'invalid', why: 'No name after the date' });
      return;
    }
    if (name.length > 100) {
      out.push({ line, text: t, status: 'invalid', why: 'Name longer than 100 characters' });
      return;
    }
    if (seen.has(lead.date)) {
      out.push({
        line,
        text: t,
        status: 'invalid',
        why: `Same date as line ${seen.get(lead.date)}`,
      });
      return;
    }
    seen.set(lead.date, String(line));
    const now = existing.find((h) => h.date === lead.date);
    out.push(
      !now
        ? { line, text: t, date: lead.date, name, status: 'new' }
        : now.name === name
          ? { line, text: t, date: lead.date, name, status: 'same' }
          : { line, text: t, date: lead.date, name, status: 'rename', was: now.name },
    );
  });
  return out;
}
