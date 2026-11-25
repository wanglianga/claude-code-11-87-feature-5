import type { DeliveryPackage, ValidationReport } from '../types';
import type { CompileInput } from '../domain/compiler';
import type { BuildPackageArgs } from '../domain/package';
import type { ValidatorContext } from '../domain/validator';

// Worker 消息协议（请求/响应按 reqId 配对）
export type WorkerRequest =
  | { reqId: number; type: 'compile'; input: CompileInput }
  | { reqId: number; type: 'buildPackage'; args: BuildPackageArgs }
  | { reqId: number; type: 'validate'; pkg: DeliveryPackage; ctx: ValidatorContext };

export type WorkerResponse =
  | { reqId: number; ok: true; data: unknown }
  | { reqId: number; ok: false; error: string };

export interface WorkerApi {
  compile(input: CompileInput): Promise<import('../types').Projection>;
  buildPackage(args: BuildPackageArgs): Promise<{ pkg: DeliveryPackage; validation: ValidationReport }>;
  validate(pkg: DeliveryPackage, ctx: ValidatorContext): Promise<ValidationReport>;
}
