import type { WorkerRequest, WorkerResponse } from '../workers/protocol';
import type { WorkerApi } from '../workers/protocol';

// 单例 Worker 客户端：reqId 配对 Promise
let worker: Worker | null = null;
let seq = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/delivery.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const res = ev.data;
    const p = pending.get(res.reqId);
    if (!p) return;
    pending.delete(res.reqId);
    if (res.ok) p.resolve(res.data);
    else p.reject(new Error(res.error));
  };
  worker.onerror = (e) => {
    for (const [, p] of pending) p.reject(new Error(e.message || 'Worker 错误'));
    pending.clear();
  };
  return worker;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function call<T>(req: DistributiveOmit<WorkerRequest, 'reqId'>): Promise<T> {
  const w = getWorker();
  const reqId = seq++;
  return new Promise<T>((resolve, reject) => {
    pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ ...req, reqId } as WorkerRequest);
  });
}

export const workerApi: WorkerApi = {
  compile: (input) => call({ type: 'compile', input }),
  buildPackage: (args) => call({ type: 'buildPackage', args }),
  validate: (pkg, ctx) => call({ type: 'validate', pkg, ctx }),
};
