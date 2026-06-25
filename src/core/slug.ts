/** Make an arbitrary filename safe across filesystems. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() || 'file';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/_+/g, '_');
  return cleaned || 'file';
}
