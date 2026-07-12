type Work<T> = () => Promise<T>;

type Slot<T> = {
  active: boolean;
  queue: Work<T>[];
  activeDone?: Promise<void>;
  drain?: Promise<void>;
};

export class ActiveTurnRegistry<T = unknown> {
  private readonly slots = new Map<string, Slot<T>>();
  private accepting = true;

  async submit(
    key: string,
    work: Work<T>,
  ): Promise<{ status: 'started'; result: T } | { status: 'queued' } | { status: 'closed' }> {
    if (!this.accepting) return { status: 'closed' };
    const slot = this.slots.get(key) ?? { active: false, queue: [] };
    this.slots.set(key, slot);
    if (slot.active || slot.drain !== undefined) {
      slot.queue.push(work);
      return { status: 'queued' };
    }
    return this.run(key, slot, work).finally(() => {
      this.scheduleDrain(key, slot);
    });
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
    this.accepting = false;
    await this.drainIdle();
  }

  private async run(
    key: string,
    slot: Slot<T>,
    work: Work<T>,
  ): Promise<{ status: 'started'; result: T }> {
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
    }
  }

  private scheduleDrain(key: string, slot: Slot<T>): void {
    if (slot.active || slot.drain !== undefined || slot.queue.length === 0) {
      if (!slot.active && slot.drain === undefined && slot.queue.length === 0) this.slots.delete(key);
      return;
    }
    slot.drain = (async () => {
      while (slot.queue.length > 0) {
        const next = slot.queue.shift();
        if (next === undefined) return;
        try {
          await this.run(key, slot, next);
        } catch {
          continue;
        }
      }
    })().finally(() => {
      delete slot.drain;
      if (slot.queue.length > 0) {
        this.scheduleDrain(key, slot);
        return;
      }
      if (!slot.active && slot.queue.length === 0) this.slots.delete(key);
    });
  }
}
