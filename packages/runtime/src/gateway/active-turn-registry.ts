type Work<T> = () => Promise<T>;

type Slot<T> = {
  active: boolean;
  activeDone?: Promise<void>;
  pending?: Work<T>;
  drain?: Promise<void>;
};

export class ActiveTurnRegistry<T = unknown> {
  private readonly slots = new Map<string, Slot<T>>();
  private shuttingDown = false;

  async submit(
    key: string,
    work: Work<T>,
  ): Promise<{ status: 'started'; result: T } | { status: 'queued' } | { status: 'closed' }> {
    if (this.shuttingDown) return { status: 'closed' };
    const slot = this.slots.get(key) ?? { active: false };
    this.slots.set(key, slot);
    if (slot.active) {
      slot.pending = work;
      return { status: 'queued' };
    }
    slot.active = true;
    let finishActive!: () => void;
    slot.activeDone = new Promise<void>((resolve) => { finishActive = resolve; });
    try {
      const result = await work();
      return { status: 'started', result };
    } finally {
      slot.active = false;
      finishActive();
      delete slot.activeDone;
      this.scheduleDrain(key, slot);
    }
  }

  activeCount(): number {
    return [...this.slots.values()].filter((slot) => slot.active).length;
  }

  async drainIdle(): Promise<void> {
    while (true) {
      const work = [...this.slots.values()]
        .flatMap((slot) => [slot.activeDone, slot.drain])
        .filter((promise): promise is Promise<void> => promise !== undefined);
      if (work.length === 0) return;
      await Promise.all(work);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const slot of this.slots.values()) delete slot.pending;
    await this.drainIdle();
  }

  private scheduleDrain(key: string, slot: Slot<T>): void {
    const pending = slot.pending;
    delete slot.pending;
    if (pending === undefined || this.shuttingDown) {
      if (!slot.active) this.slots.delete(key);
      return;
    }
    slot.drain = (async () => {
      try {
        await this.submit(key, pending);
      } catch {
        return;
      }
    })();
  }
}
