/**
 * Time utility functions for Domino Sky
 * All operational times are IST (UTC+05:30) in 24-hour format HH:MM.
 */

/**
 * Parses "HH:MM" into total minutes from start of operating day (00:00 = 0).
 * Rejects invalid, non-string, or out-of-range inputs.
 */
export function parseTimeToMinutes(timeStr: string): number {
  if (typeof timeStr !== 'string') {
    throw new Error(`Invalid time input: expected string, got ${typeof timeStr}`);
  }

  const trimmed = timeStr.trim();
  const match = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid time format: "${timeStr}". Expected "HH:MM" (e.g. "08:30")`);
  }

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);

  if (hours < 0 || hours > 23) {
    throw new Error(`Invalid hours in time "${timeStr}": hours must be 0-23`);
  }

  if (minutes < 0 || minutes > 59) {
    throw new Error(`Invalid minutes in time "${timeStr}": minutes must be 0-59`);
  }

  return hours * 60 + minutes;
}

/**
 * Formats minutes from day start into standard "HH:MM".
 * Correctly annotates times crossing midnight (>= 1440 mins).
 * Examples:
 *   480   -> "08:00"
 *   1440  -> "00:00 (+1d)"
 *   1505  -> "01:05 (+1d)"
 */
export function formatMinutesToTime(totalMinutes: number): string {
  if (typeof totalMinutes !== 'number' || isNaN(totalMinutes)) {
    throw new Error(`Invalid minutes input: ${totalMinutes}`);
  }

  if (totalMinutes < 0) {
    throw new Error(`Negative minute values not supported: ${totalMinutes}`);
  }

  const days = Math.floor(totalMinutes / 1440);
  const remainder = totalMinutes % 1440;
  const hours = Math.floor(remainder / 60);
  const minutes = remainder % 60;

  const hh = hours.toString().padStart(2, '0');
  const mm = minutes.toString().padStart(2, '0');

  if (days === 0) {
    return `${hh}:${mm}`;
  }

  return `${hh}:${mm} (+${days}d)`;
}

/**
 * Formats minutes strictly as raw 24h HH:MM without day annotation (modulo 1440).
 */
export function formatMinutesNormalized(totalMinutes: number): string {
  if (totalMinutes < 0) {
    throw new Error(`Negative minute values not supported: ${totalMinutes}`);
  }
  const remainder = totalMinutes % 1440;
  const hours = Math.floor(remainder / 60);
  const minutes = remainder % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

/**
 * Computes minute difference between two time strings.
 */
export function timeDifferenceMinutes(startStr: string, endStr: string): number {
  return parseTimeToMinutes(endStr) - parseTimeToMinutes(startStr);
}
