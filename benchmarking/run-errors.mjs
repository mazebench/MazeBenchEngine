// Presentation-only helpers. Keep the original provider error in the run record.
export function rateLimitDetails(value) {
  let message = String(value || '');
  try {
    const parsed = JSON.parse(message);
    message = String(parsed.error?.message || parsed.message || message);
  } catch { /* Most providers return ordinary error text. */ }
  if (!/\b429\b|rate[_ -]?limit|(?:quota|usage (?:window|limit)).{0,40}(?:exhausted|exceeded|reached)|too many requests/i.test(message)) return null;
  // Only parse an explicitly identified reset/retry time with a timezone. A
  // request timestamp or an ambiguous local date is not reset-time evidence.
  const timestamp = message.match(/(?:resets?(?:\s+(?:at|on))?|retry\s+(?:at|after)|try again\s+(?:at|after))\s*:?\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}|\s+(?:UTC|GMT)))/i)?.[1];
  const reset = timestamp ? Date.parse(timestamp.replace(/\s+(?:UTC|GMT)$/i, 'Z').replace(' ', 'T')) : NaN;
  return { reset_at: Number.isFinite(reset) ? new Date(reset).toISOString() : null };
}

function calendarDay(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric'
  }).formatToParts(date).map(part => [part.type, part.value]));
  return { key: Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)), year: parts.year };
}

export function formatRateLimit(details, { now = Date.now(), locale, timeZone } = {}) {
  if (!details) return null;
  const reset = new Date(details.reset_at || NaN);
  if (!Number.isFinite(reset.getTime())) return 'The provider did not report a reset time. Try again later.';
  const today = calendarDay(new Date(now), timeZone), day = calendarDay(reset, timeZone);
  const label = day.key === today.key ? 'today' : day.key === today.key + 86400000 ? 'tomorrow'
    : new Intl.DateTimeFormat(locale, { timeZone, month: 'short', day: 'numeric', ...(day.year !== today.year ? { year: 'numeric' } : {}) }).format(reset);
  const time = new Intl.DateTimeFormat(locale, { timeZone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(reset);
  const when = `${label} at ${time}`;
  const remaining = reset.getTime() - now;
  if (remaining <= 0) return `The reported reset time has passed (${when}). You can try again.`;
  const minutes = Math.ceil(remaining / 60000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  const wait = remaining < 60000 ? 'less than a minute' : days ? `${days}d${hours % 24 ? ` ${hours % 24}h` : ''}`
    : hours ? `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${minutes}m`;
  return `Resets ${when} (in ${wait}).`;
}
