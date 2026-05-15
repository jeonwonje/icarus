/**
 * Sanitize a user-supplied filename for safe on-disk use: strip path
 * separators and `..` runs, trim leading dots.
 */
export function sanitizeFileName(name: string): string {
  let safe = name.replace(/[/\\]/g, '_').replace(/\.\./g, '_');
  safe = safe.replace(/^\.+/, '');
  if (!safe) safe = 'file';
  return safe;
}
