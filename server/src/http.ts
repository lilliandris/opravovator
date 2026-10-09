export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Serializuje asynchrónne úlohy podľa kľúča (napr. zápisy jedného riešenia). */
const queues = new Map<string, Promise<unknown>>();
export function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}

/** Obmedzí počet súčasne bežiacich úloh (napr. generovanie miniatúr). */
export function limiter(max: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (running >= max) await new Promise<void>(r => waiting.push(r));
    running++;
    try {
      return await fn();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}
