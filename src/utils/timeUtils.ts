const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * Format an ISO timestamp as a short relative age, e.g. "5m ago", "3h ago",
 * "2d ago", "3w ago". Falls back to an absolute date beyond 30 days.
 */
export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (isNaN(then)) { return ''; }
  const diff = Date.now() - then;

  if (diff < MINUTE) { return 'just now'; }
  if (diff < HOUR) { return `${Math.floor(diff / MINUTE)}m ago`; }
  if (diff < DAY) { return `${Math.floor(diff / HOUR)}h ago`; }
  if (diff < 30 * DAY) {
    const days = Math.floor(diff / DAY);
    return days < 7 ? `${days}d ago` : `${Math.floor(diff / WEEK)}w ago`;
  }
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
