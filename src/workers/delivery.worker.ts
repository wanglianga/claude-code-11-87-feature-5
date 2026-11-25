// WebWorker：把投影编译、包构建、签名与校验移出主线程。
// 注意：不引用 DOM 专有 API；哈希使用全局 crypto.subtle（Worker 可用）。
import { compileProjection } from '../domain/compiler';
import { buildDeliveryPackage } from '../domain/package';
import { validatePackage } from '../domain/validator';
import type { WorkerRequest, WorkerResponse } from './protocol';

const workerScope = self as unknown as {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void | Promise<void>) | null;
  postMessage: (msg: WorkerResponse) => void;
};

workerScope.onmessage = async (ev) => {
  const req = ev.data;
  try {
    let data: unknown;
    if (req.type === 'compile') {
      data = compileProjection(req.input);
    } else if (req.type === 'buildPackage') {
      data = await buildDeliveryPackage(req.args);
    } else if (req.type === 'validate') {
      data = await validatePackage(req.pkg, req.ctx);
    }
    workerScope.postMessage({ reqId: req.reqId, ok: true, data });
  } catch (err) {
    workerScope.postMessage({
      reqId: req.reqId,
      ok: false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  }
};
