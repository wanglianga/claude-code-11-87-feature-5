import type {
  ObservationProbe,
  Projection,
  ReplayReport,
  SemanticBenchmark,
} from '../../types';
import { uid } from '../hash';
import { compileProjection } from '../compiler';
import { interpretProbe } from './diff';
import {
  BENCHMARK_ACCOUNT,
  BENCHMARK_LICENSE,
  benchmarkAsReport,
  buildReferenceProbe,
  runConsumerProbe,
  type ConsumerProfile,
} from './probe';

// ============================================================
// 差分回放（Differential Replay）
// 让“参考实现（平台投影编译器）”与“消费方处理器”处理【同一版本】
// 受控样本，分别产出探针结果，再由差异解释器定位具体语义分歧。
// 注意纪律：回放必须由消费方执行（或回传其探针），平台不能代替消费方
// 解释数据；样本版本/哈希/契约版本/策略指纹任一不匹配即绑定失效。
// ============================================================

export interface ReplayArgs {
  benchmark: SemanticBenchmark;
  consumer: ConsumerProfile;
  atIso: string;
  /** 实时策略指纹（与样本冻结时的指纹比对） */
  currentPolicyFingerprint: string;
}

/** 参考实现侧：把冻结样本送进真实投影编译器，再收集探针 */
export function runReferenceProjection(benchmark: SemanticBenchmark, atIso: string): Projection {
  const report = benchmarkAsReport(benchmark);
  return compileProjection({
    report,
    revision: 1,
    account: BENCHMARK_ACCOUNT,
    license: BENCHMARK_LICENSE,
    purpose: 'deliver',
    mode: 'materialized',
    atIso,
    attachmentMap: new Map(),
  });
}

export function differentialReplay(args: ReplayArgs): ReplayReport {
  const { benchmark, consumer, atIso, currentPolicyFingerprint } = args;

  // 1) 参考实现处理同一版本样本
  const referenceProjection = runReferenceProjection(benchmark, atIso);
  const referenceProbe: ObservationProbe = buildReferenceProbe(benchmark, referenceProjection, atIso);

  // 2) 消费方处理同一版本样本（消费方执行回放，平台只接收探针）
  const consumerProbe = runConsumerProbe(benchmark, consumer, atIso);

  // 3) 差异解释：以冻结样本的投影预期为基准
  const probeReport = interpretProbe({ benchmark, probe: consumerProbe, currentPolicyFingerprint });

  const bindingValid =
    referenceProbe.benchmarkHash === benchmark.benchmarkHash &&
    consumerProbe.benchmarkHash === benchmark.benchmarkHash &&
    referenceProbe.contractVersion === benchmark.contractVersion &&
    consumerProbe.contractVersion === benchmark.contractVersion &&
    currentPolicyFingerprint === benchmark.policyFingerprint;

  return {
    replayId: uid('RPL'),
    benchmarkVersion: benchmark.benchmarkVersion,
    benchmarkHash: benchmark.benchmarkHash,
    contractVersion: benchmark.contractVersion,
    consumerId: consumer.consumerId,
    ranAt: atIso,
    referenceProbe,
    consumerProbe,
    probeReport,
    bindingValid,
  };
}

/** 供外部消费方回传探针时使用：只解释，不重放参考侧之外的内容 */
export function interpretConsumerProbe(
  benchmark: SemanticBenchmark,
  consumerProbe: ObservationProbe,
  currentPolicyFingerprint: string,
) {
  return interpretProbe({ benchmark, probe: consumerProbe, currentPolicyFingerprint });
}
