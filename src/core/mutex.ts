/** Per-key mutual exclusion so turns in one channel serialize. */
export class ChannelMutex {
  private locked = new Set<string>();
  private waiters = new Map<string, Array<() => void>>();

  isLocked(key: string): boolean {
    return this.locked.has(key);
  }

  acquire(key: string): Promise<void> {
    if (!this.locked.has(key)) {
      this.locked.add(key);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const q = this.waiters.get(key) ?? [];
      q.push(resolve);
      this.waiters.set(key, q);
    });
  }

  release(key: string): void {
    const q = this.waiters.get(key);
    if (q && q.length) {
      const next = q.shift()!;
      next();
      return;
    }
    this.locked.delete(key);
  }
}
