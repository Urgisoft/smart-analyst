/**
 * Shared worker pool for batch_backtest.ts and watch_candles.ts.
 *
 * Spawns N tsx-aware worker_threads (via _worker_shim.mjs), distributes BatchCell jobs to
 * idle workers, drains the queue, and resolves when every cell has come back.
 *
 * Workers stay alive across enqueue() calls — the watcher reuses one pool across many ticks.
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { BatchCell, BatchCellResult } from './batch_backtest_worker.js';

void fileURLToPath; // referenced by URL() below; keeps type-checker quiet

export class WorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Array<{ cell: BatchCell; cellIndex: number }> = [];
  private inFlight = 0;
  private resolveDone: (() => void) | null = null;

  constructor(
    private size: number,
    private onResult: (r: BatchCellResult) => void,
  ) {}

  async start(): Promise<void> {
    // The .mjs shim programmatically registers tsx inside the worker before dynamically
    // importing the .ts worker. The parent's --import tsx flag does NOT propagate to children.
    const workerUrl = new URL('./_worker_shim.mjs', import.meta.url);
    const ready: Promise<void>[] = [];
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(workerUrl);
      this.workers.push(w);
      ready.push(new Promise<void>((res) => {
        const onReady = (msg: unknown) => {
          if (msg && (msg as { kind?: string }).kind === 'ready') {
            w.off('message', onReady);
            this.idle.push(w);
            res();
          }
        };
        w.on('message', onReady);
      }));
      w.on('message', (msg: unknown) => {
        if (msg && (msg as { kind?: string }).kind === 'ready') return;
        const result = msg as BatchCellResult;
        this.inFlight--;
        this.idle.push(w);
        this.onResult(result);
        this.dispatch();
        if (this.queue.length === 0 && this.inFlight === 0) this.resolveDone?.();
      });
      w.on('error', (e) => console.error('worker error:', e));
    }
    await Promise.all(ready);
  }

  /** Enqueue a batch of cells; resolves when the queue drains. Re-callable across ticks. */
  enqueue(cells: { cell: BatchCell; cellIndex: number }[]): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveDone = resolve;
      this.queue.push(...cells);
      this.dispatch();
      if (this.queue.length === 0 && this.inFlight === 0) resolve();
    });
  }

  private dispatch() {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const w = this.idle.shift()!;
      const job = this.queue.shift()!;
      this.inFlight++;
      w.postMessage({ kind: 'cell', cell: job.cell, cellIndex: job.cellIndex });
    }
  }

  async terminate() {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
    this.idle = [];
  }
}
