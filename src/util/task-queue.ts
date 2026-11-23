/**
 * Bounded FIFO task queue with concurrency limiting.
 *
 * All async scan triggers (webhook, dashboard, scheduler) go through here so
 * the server never runs more than `maxConcurrent` scans at once. Backpressure
 * is applied at enqueue time: if the queue is full, the job is rejected and
 * the caller (HTTP) returns 503.
 */
import { logger } from './logger.js';

export interface QueuedJob<T = unknown> {
  id: string;
  name: string;
  run: () => Promise<T>;
}

interface InternalJob extends QueuedJob {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  createdAt: number;
}

export class TaskQueue {
  private pending: InternalJob[] = [];
  private running = 0;
  private seq = 0;

  constructor(
    private readonly maxConcurrent = 2,
    private readonly maxQueueSize = 100,
  ) {}

  get stats() {
    return {
      running: this.running,
      pending: this.pending.length,
      maxConcurrent: this.maxConcurrent,
      maxQueueSize: this.maxQueueSize,
    };
  }

  enqueue<T>(name: string, run: () => Promise<T>): Promise<T> {
    if (this.pending.length >= this.maxQueueSize) {
      return Promise.reject(new Error(`queue full (${this.maxQueueSize})`));
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        id: `job-${++this.seq}`,
        name,
        run,
        resolve: resolve as (v: unknown) => void,
        reject,
        createdAt: Date.now(),
      });
      this.drain();
    });
  }

  private drain(): void {
    if (this.running >= this.maxConcurrent) return;
    const job = this.pending.shift();
    if (!job) return;
    this.running++;
    const started = Date.now();
    logger.info(
      `queue: start ${job.name} (${this.running}/${this.maxConcurrent}, pending ${this.pending.length})`,
    );
    Promise.resolve()
      .then(() => job.run())
      .then(
        (v) => {
          logger.info(`queue: done ${job.name} in ${Date.now() - started}ms`);
          job.resolve(v);
        },
        (err: unknown) => {
          logger.error(`queue: failed ${job.name}: ${(err as Error).message}`);
          job.reject(err as Error);
        },
      )
      .finally(() => {
        this.running--;
        this.drain();
      });
  }
}

/** Single shared queue for the whole server process. */
export const scanQueue = new TaskQueue(
  Number(process.env.CHANGEGUARD_MAX_CONCURRENT || 2),
  Number(process.env.CHANGEGUARD_MAX_QUEUE || 100),
);
