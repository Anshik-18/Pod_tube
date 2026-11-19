/** 75 -> "01:15", 3725 -> "1:02:05" */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Human duration: "42s", "12 min", "1 h 05 min" */
export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

const rtf = typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat('en', { numeric: 'auto' }) : null;

/** "just now", "5 minutes ago", "yesterday", then "Mar 4" / "Mar 4, 2024" */
export function formatRelativeDate(value: string | Date): string {
  const date = new Date(value);
  const diffSec = (date.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diffSec);
  if (abs < 45) return 'just now';
  if (rtf) {
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour');
    if (abs < 86400 * 6) return rtf.format(Math.round(diffSec / 86400), 'day');
  }
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function formatDateTime(value: string | Date): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function initials(name: string | null | undefined): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function displayNameFromEmail(email: string | null | undefined): string {
  if (!email) return 'there';
  const local = email.split('@')[0].replace(/[._-]+/g, ' ');
  return local.charAt(0).toUpperCase() + local.slice(1);
}

export function episodeTitle(episode: { title: string | null; id: string }): string {
  return episode.title?.trim() || 'Untitled recording';
}
