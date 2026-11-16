import { AppError } from './errors.js';

/** FIFO semaphore with a bounded waiting line; overflowing callers get a `busy` error. */
export function createSemaphore({ limit, maxWaiting }) {
  let running = 0;
  let closed = false;
  const waiting = []; // { resolve, reject }

  function release() {
    const next = waiting.shift();
    if (next) next.resolve();
    else running -= 1;
  }

  return {
    async run(fn) {
      if (closed) throw new AppError('busy');
      if (running < limit) {
        running += 1;
      } else {
        if (waiting.length >= maxWaiting) throw new AppError('busy');
        await new Promise((resolve, reject) => waiting.push({ resolve, reject }));
      }
      try {
        return await fn();
      } finally {
        release();
      }
    },
    /** Shutdown: everyone still in line is turned away and nobody new gets in. */
    close() {
      closed = true;
      for (const waiter of waiting.splice(0)) waiter.reject(new AppError('busy'));
    },
    get running() {
      return running;
    },
    get waiting() {
      return waiting.length;
    },
  };
}
