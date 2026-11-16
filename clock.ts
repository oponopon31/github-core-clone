// Deterministic logical clock for the forge.
//
// Every timestamp the server emits comes from here. The base is the trial
// time from MAKEFUN_TRIAL_NOW (RFC3339 or epoch milliseconds), falling back
// to 2025-01-01T00:00:00Z. Each mutation advances the clock by exactly one
// second. Nothing in a request path reads the wall clock or any other
// nondeterministic source.

const FALLBACK_BASE_MS = 1735689600000; // 2025-01-01T00:00:00Z

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

// Days from civil date, Howard Hinnant's algorithm. 1970-01-01 -> 0.
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400; // [0, 399]
  const mp = month > 2 ? month - 3 : month + 9; // Mar=0 .. Feb=11
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

// Civil date from days since 1970-01-01.
function civilFromDays(z: number): { year: number; month: number; day: number } {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097; // [0, 146096]
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153); // Mar=0 .. Feb=11
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: month <= 2 ? y + 1 : y, month, day };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function pad4(n: number): string {
  if (n < 10) return `000${n}`;
  if (n < 100) return `00${n}`;
  if (n < 1000) return `0${n}`;
  return `${n}`;
}

/** Format epoch milliseconds as an ISO-8601 UTC string, e.g. 2025-01-01T00:00:00Z. */
export function formatIso(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const secsOfDay = totalSeconds - days * 86400;
  const { year, month, day } = civilFromDays(days);
  const hour = Math.floor(secsOfDay / 3600);
  const minute = Math.floor((secsOfDay % 3600) / 60);
  const second = secsOfDay % 60;
  return `${pad4(year)}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}Z`;
}

/** Parse an RFC3339 timestamp or a decimal epoch-millisecond string. Null when unparsable. */
export function parseTrialNow(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (text === '') return null;
  if (/^-?\d+$/.test(text)) {
    const ms = Number(text);
    return Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:?\d{2})?$/.exec(text);
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null;
  const monthLengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > (monthLengths[month - 1] ?? 31)) return null;
  let offsetMs = 0;
  const zone = m[8] ?? 'Z';
  if (zone !== 'Z' && zone !== 'z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const zh = Number(digits.slice(0, 2));
    const zm = Number(digits.slice(2, 4));
    offsetMs = sign * (zh * 3600 + zm * 60) * 1000;
  }
  const frac = m[7] ?? '';
  const fracMs = frac === '' ? 0 : Number((frac + '000').slice(0, 3));
  const days = daysFromCivil(year, month, day);
  return days * 86400000 + (hour * 3600 + minute * 60 + second) * 1000 + fracMs - offsetMs;
}

export class LogicalClock {
  baseMs: number;
  ticks: number;

  constructor(envValue: string | undefined) {
    const parsed = parseTrialNow(envValue);
    this.baseMs = parsed ?? FALLBACK_BASE_MS;
    this.ticks = 0;
  }

  /** Current logical time in epoch milliseconds (does not advance). */
  nowMs(): number {
    return this.baseMs + this.ticks * 1000;
  }

  /** Advance by one second and return the new time in epoch milliseconds. */
  tickMs(): number {
    this.ticks += 1;
    return this.nowMs();
  }

  /** Current logical time as ISO-8601 UTC (does not advance). */
  nowIso(): string {
    return formatIso(this.nowMs());
  }

  /** Advance by one second and return the new time as ISO-8601 UTC. */
  tickIso(): string {
    return formatIso(this.tickMs());
  }

  /** Advance by one second and return the new time in epoch seconds (for git objects). */
  tickEpochSec(): number {
    return Math.floor(this.tickMs() / 1000);
  }
}
