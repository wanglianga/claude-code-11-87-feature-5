import type {
  Account,
  Authorization,
  BenchmarkDefect,
  FieldObservation,
  ObservationProbe,
  Projection,
  ProjectedDefect,
  Report,
  SemanticBenchmark,
} from '../../types';
import { uid } from '../hash';
import { formatMeasure } from '../format';
import { BENCHMARK_VERSION, REFERENCE_CONSUMER } from './benchmark';

// ============================================================
// 输出观测探针（Observation Probe）
// 消费方（或参考实现）处理同一版本受控样本后，把“结果摘要”回传给探针：
// 每个实体 × 字段的机器值、展示文本、声明接收单位、是否被过滤缺省，
// 以及消费方自己的聚合口径。差异解释器（diff.ts）再与投影预期逐项比对。
// ============================================================

/** 消费方处理器：输入一条受控样本，输出该样本的字段观测（未授权实体应返回空数组） */
export type ConsumerHandler = (defect: BenchmarkDefect) => FieldObservation[];

export interface ConsumerProfile {
  consumerId: string;
  consumerName: string;
  handler: ConsumerHandler;
  /** 消费方自报聚合摘要（模拟其报表统计模块的口径） */
  aggregation: (defects: BenchmarkDefect[]) => ObservationProbe['aggregationSummary'];
}

function probeBase(benchmark: SemanticBenchmark, consumerId: string, consumerName: string, ranAt: string) {
  return {
    probeId: uid('PRB'),
    consumerId,
    consumerName,
    benchmarkVersion: benchmark.benchmarkVersion,
    benchmarkHash: benchmark.benchmarkHash,
    contractVersion: benchmark.contractVersion,
    ranAt,
  };
}

/** 把投影编译器产出的 ProjectedDefect 转成探针观测（参考实现口径） */
export function collectObservationsFromProjection(defects: ProjectedDefect[]): FieldObservation[] {
  const out: FieldObservation[] = [];
  for (const d of defects) {
    if (d.sectionId) {
      out.push({ defectId: d.defectId, fieldKey: 'sectionId', observedValue: d.sectionId.value, observedDisplay: d.sectionId.display });
    }
    if (d.coordinate) {
      out.push({
        defectId: d.defectId,
        fieldKey: 'coordinate',
        observedValue: d.coordinate.value,
        observedDisplay: d.coordinate.display,
        observedUnit: d.coordinate.unit,
      });
    }
    if (d.crackWidth) {
      out.push({
        defectId: d.defectId,
        fieldKey: 'crackWidthMm',
        observedValue: d.crackWidth.belowDetectionLimit ? '<LOD>' : d.crackWidth.value,
        observedDisplay: d.crackWidth.display,
        observedUnit: d.crackWidth.unit,
        reasonCodes: d.crackWidth.decision.reasons.map((r) => r.code),
      });
    }
    if (d.detectionMethod) {
      out.push({ defectId: d.defectId, fieldKey: 'detectionMethod', observedValue: d.detectionMethod.value, observedDisplay: d.detectionMethod.display });
    }
    if (d.imageSummary) {
      out.push({ defectId: d.defectId, fieldKey: 'imageSummary', observedValue: d.imageSummary.value, observedDisplay: d.imageSummary.display });
    }
    if (d.rectificationStatus) {
      out.push({ defectId: d.defectId, fieldKey: 'rectificationStatus', observedValue: d.rectificationStatus.value, observedDisplay: d.rectificationStatus.display });
    }
    if (d.verifiedAt) {
      out.push({ defectId: d.defectId, fieldKey: 'verifiedAt', observedValue: d.verifiedAt.value, observedDisplay: d.verifiedAt.display });
    }
  }
  return out;
}

/** 参考实现的聚合摘要：严格按契约口径，null / <LOD 不计入 */
function referenceAggregation(defects: BenchmarkDefect[]): ObservationProbe['aggregationSummary'] {
  const countable: number[] = [];
  for (const d of defects) {
    if (!REFERENCE_CONSUMER.visibleSections.includes(d.sectionId)) continue;
    const m = formatMeasure('crackWidthMm', d.crackWidthMm);
    if (m.value !== null && !m.belowDetectionLimit) countable.push(m.value);
  }
  const sum = Math.round((countable.reduce((a, b) => a + b, 0) + Number.EPSILON) * 10) / 10;
  return {
    countedAsZero: [],
    sumMm: sum,
    count: countable.length,
    avgMm: countable.length ? Math.round((sum / countable.length + Number.EPSILON) * 10) / 10 : null,
  };
}

/** 由投影结果直接构建参考实现探针（差分回放中的 reference 一侧） */
export function buildReferenceProbe(
  benchmark: SemanticBenchmark,
  projection: Projection,
  ranAt: string,
): ObservationProbe {
  return {
    ...probeBase(benchmark, REFERENCE_CONSUMER.consumerId, REFERENCE_CONSUMER.consumerName, ranAt),
    observations: collectObservationsFromProjection(projection.defects),
    aggregationSummary: referenceAggregation(benchmark.defects),
  };
}

/** 运行任意消费方处理器，收集其对整个冻结样本集的探针结果 */
export function runConsumerProbe(
  benchmark: SemanticBenchmark,
  profile: ConsumerProfile,
  ranAt: string,
): ObservationProbe {
  const observations = benchmark.defects.flatMap((d) => profile.handler(d));
  return {
    ...probeBase(benchmark, profile.consumerId, profile.consumerName, ranAt),
    observations,
    aggregationSummary: profile.aggregation(benchmark.defects),
  };
}

// ---------------- 参考实现编译器接线 ----------------

/** 把受控样本集伪装成一份报告修订，供真实投影编译器处理 */
export function benchmarkAsReport(benchmark: SemanticBenchmark): Report {
  const revision = {
    reportNo: 'RB-SEMANTIC',
    revision: 1,
    projectId: 'P',
    title: '语义基准受控样本（不作为业务交付）',
    publishedAt: benchmark.createdAt,
    changeNote: 'semantic benchmark fixture',
    changes: [],
    defects: benchmark.defects as unknown as Report['revisions'][number]['defects'],
    reportHash: benchmark.benchmarkHash,
    signedBy: 'semantic-gate',
    signature: 'semantic-benchmark-fixture',
    signedAt: benchmark.createdAt,
  };
  return { reportNo: 'RB-SEMANTIC', projectId: 'P', currentRevision: 1, revisions: [revision] };
}

export const BENCHMARK_ACCOUNT: Account = {
  accountId: 'u-semantic-ref',
  username: 'semantic-ref',
  password: '-',
  displayName: '语义基准参考画像（B1）',
  role: 'builder',
  org: '语义门禁',
  sectionIds: ['B1'],
};

export const BENCHMARK_LICENSE: Authorization = {
  licenseId: 'LIC-SEMANTIC-REF',
  licenseVersion: 1,
  accountId: BENCHMARK_ACCOUNT.accountId,
  role: 'builder',
  projectId: 'P',
  sectionIds: ['B1'],
  fieldGroups: ['identity', 'location', 'measurement', 'workflow', 'media'],
  purposes: ['deliver', 'review'],
  validFrom: '2026-01-01T00:00:00+08:00',
  validUntil: '2026-12-31T23:59:59+08:00',
  status: 'active',
  issuedAt: '2026-01-05T09:00:00+08:00',
};

export { BENCHMARK_VERSION };
