import { BackpressureError } from "./errors.js";

type ReleaseFn = () => void;

class Semaphore {
  private readonly queue: Array<{
    resolve: (release: ReleaseFn) => void;
  }> = [];

  constructor(
    private available: number,
    private readonly maxQueueSize: number,
    private readonly backpressureMessage: string,
    private readonly retryAfterMs = 1000
  ) {
    if (!Number.isInteger(available) || available <= 0) {
      throw new Error("Semaphore capacity must be a positive integer");
    }
    if (!Number.isInteger(maxQueueSize) || maxQueueSize < 0) {
      throw new Error("Semaphore maxQueueSize must be a non-negative integer");
    }
  }

  async acquire(): Promise<ReleaseFn> {
    if (this.available > 0) {
      this.available -= 1;
      return this.makeRelease();
    }

    if (this.queue.length >= this.maxQueueSize) {
      throw new BackpressureError(this.backpressureMessage, this.retryAfterMs);
    }

    return await new Promise<ReleaseFn>((resolve) => {
      this.queue.push({ resolve });
    });
  }

  private makeRelease(): ReleaseFn {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this.queue.shift();
      if (next) {
        next.resolve(this.makeRelease());
        return;
      }
      this.available += 1;
    };
  }
}

class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(key, tail);

    try {
      return await current;
    } finally {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}

class SingleFlight {
  private readonly inflight = new Map<string, Promise<unknown>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      return (await existing) as T;
    }

    const promise = operation().finally(() => {
      if (this.inflight.get(key) === promise) {
        this.inflight.delete(key);
      }
    });

    this.inflight.set(key, promise);
    return await promise;
  }
}

export class ToolExecutionGate {
  private readonly toolSemaphore: Semaphore;
  private readonly mutatingSemaphore: Semaphore;
  private readonly presentationMutex = new KeyedMutex();
  private readonly readOnlySingleFlight = new SingleFlight();

  constructor(
    maxToolConcurrency: number,
    maxMutatingConcurrency: number,
    maxPendingToolRequests: number
  ) {
    const sharedQueueSize = Math.max(0, maxPendingToolRequests);
    this.toolSemaphore = new Semaphore(
      maxToolConcurrency,
      sharedQueueSize,
      "ToseaAI MCP server is locally saturated. Retry after a short delay."
    );
    this.mutatingSemaphore = new Semaphore(
      maxMutatingConcurrency,
      sharedQueueSize,
      "ToseaAI MCP server is busy processing mutating requests. Retry with the same idempotency key."
    );
  }

  async runReadOnly<T>(
    operation: () => Promise<T>,
    dedupeKey?: string
  ): Promise<T> {
    const runWithSemaphore = async (): Promise<T> => {
      const release = await this.toolSemaphore.acquire();
      try {
        return await operation();
      } finally {
        release();
      }
    };

    if (!dedupeKey) {
      return await runWithSemaphore();
    }

    return await this.readOnlySingleFlight.run(dedupeKey, runWithSemaphore);
  }

  async runMutating<T>(
    operation: () => Promise<T>,
    presentationId?: string
  ): Promise<T> {
    const runWithSemaphore = async (): Promise<T> => {
      const releaseTool = await this.toolSemaphore.acquire();
      const releaseMutating = await this.mutatingSemaphore.acquire();
      try {
        return await operation();
      } finally {
        releaseMutating();
        releaseTool();
      }
    };

    if (!presentationId) {
      return await runWithSemaphore();
    }

    return await this.presentationMutex.runExclusive(
      presentationId,
      runWithSemaphore
    );
  }
}
