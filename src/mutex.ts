/**
 * Trivial per-key async mutex. Replaces nanoclaw's 378-LOC GroupQueue.
 * Callers serialize their own pending-work queue; this only coordinates
 * "exactly one owner at a time" per key.
 */
export class TopicMutex {
  private locks = new Map<string, boolean>();
  private waiters = new Map<string, Array<() => void>>();

  async acquire(slug: string): Promise<void> {
    if (!this.locks.get(slug)) {
      this.locks.set(slug, true);
      return;
    }
    await new Promise<void>((resolve) => {
      const list = this.waiters.get(slug) ?? [];
      list.push(resolve);
      this.waiters.set(slug, list);
    });
    this.locks.set(slug, true);
  }

  release(slug: string): void {
    this.locks.set(slug, false);
    const list = this.waiters.get(slug) ?? [];
    const next = list.shift();
    this.waiters.set(slug, list);
    if (next) next();
  }

  isLocked(slug: string): boolean {
    return !!this.locks.get(slug);
  }
}
