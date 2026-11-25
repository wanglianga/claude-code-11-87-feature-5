import type {
  BenchmarkDefect,
  BenchmarkExpectation,
  ReasonCode,
  SemanticBenchmark,
} from '../../types';
import { CONTRACT_VERSION } from '../../types';
import { canonicalStringify } from '../hash';
import { sha256HexSync } from '../sha256';
import { enumLabel, formatCoordinate, formatDateTime, formatMeasure } from '../format';
import { computePolicyFingerprint, SEMANTIC_CONTRACT_VERSION } from './contract';

// ============================================================
// 受控基准输入集（Semantic Benchmark）
// 样本刻意覆盖消费方最容易解释错的语义边界：
//   正常舍入 / 舍入边界 / 低于检出限 / 测量缺失(null) / 坐标缺失(null) /
//   枚举缺失(null≠默认值) / 时间缺失(null≠纪元) / 标段过滤。
// 样本集带版本号并对规范化内容计算哈希，与契约版本、策略指纹冻结绑定：
// 任何字节变化都会改变 benchmarkHash，使旧探针/旧回放的绑定校验失败。
// ============================================================

export const BENCHMARK_VERSION = 'sb-2026.1';

/** 参考消费方画像：施工方 B1 标段、含 measurement/workflow/location/media 字段组 */
export const REFERENCE_CONSUMER = {
  consumerId: 'ref-dcp-projection-compiler',
  consumerName: '平台参考投影编译器（契约口径）',
  /** 参考画像可见标段；B2 样本在该画像下必须被过滤 */
  visibleSections: ['B1'] as string[],
};

const AT_BASELINE = '2026-11-25T10:00:00+08:00';

/** 受控样本：每条都标注其专门覆盖的语义边界 */
export const BENCHMARK_DEFECTS: BenchmarkDefect[] = [
  {
    defectId: 'SB-001',
    sectionId: 'B1',
    coordinate: { x: 51230.46, y: 38821.74 },
    crackWidthMm: 12.03, // → 12.0 mm（常规舍入）
    detectionMethod: 'crack_gauge',
    imageSummary: '腹板斜向裂缝，受控样本：常规一位小数舍入。',
    rectificationStatus: 'rectified',
    verifiedAt: null,
    attachmentIds: [],
    semanticTags: ['normal-rounding', 'coordinate-rounding'],
  },
  {
    defectId: 'SB-002',
    sectionId: 'B1',
    coordinate: { x: 51244.12, y: 38830.08 },
    crackWidthMm: 0.04, // 低于检出限 → <0.1 mm，严禁变成 0.0
    detectionMethod: 'crack_gauge',
    imageSummary: '受控样本：亚检出限读数。',
    rectificationStatus: 'open',
    verifiedAt: null,
    attachmentIds: [],
    semanticTags: ['below-detection-limit'],
  },
  {
    defectId: 'SB-003',
    sectionId: 'B1',
    coordinate: { x: 51250.0, y: 38840.0 },
    crackWidthMm: null, // 未测量 → null 必须保留，禁止按 0 聚合
    detectionMethod: 'visual',
    imageSummary: '受控样本：测量缺失。',
    rectificationStatus: 'in_progress',
    verifiedAt: null,
    attachmentIds: [],
    semanticTags: ['missing-null-measurement'],
  },
  {
    defectId: 'SB-004',
    sectionId: 'B1',
    coordinate: null, // 未采集坐标 → 不是原点 (0,0)
    crackWidthMm: 5.57, // → 5.6 mm
    detectionMethod: 'ultrasonic',
    imageSummary: '受控样本：坐标缺失。',
    rectificationStatus: 'open',
    verifiedAt: null,
    attachmentIds: [],
    semanticTags: ['missing-null-coordinate'],
  },
  {
    defectId: 'SB-005',
    sectionId: 'B1',
    coordinate: { x: 51260.31, y: 38850.82 },
    crackWidthMm: 3.3,
    detectionMethod: null, // 未记录方法 ≠ visual
    imageSummary: null, // 无摘要 ≠ 影像正常
    rectificationStatus: null, // 未填报状态 ≠ open
    verifiedAt: null, // 未核验 ≠ 纪元时间
    attachmentIds: [],
    semanticTags: ['missing-enum-null', 'missing-datetime-null', 'missing-text-null'],
  },
  {
    defectId: 'SB-006',
    sectionId: 'B2', // 参考画像（仅 B1）下必须整体过滤
    coordinate: { x: 51388.91, y: 38902.55 },
    crackWidthMm: 8.62,
    detectionMethod: 'crack_gauge',
    imageSummary: '受控样本：跨标段过滤。',
    rectificationStatus: 'verified',
    verifiedAt: '2026-11-10T15:30:00+08:00',
    attachmentIds: [],
    semanticTags: ['section-filtered'],
  },
  {
    defectId: 'SB-007',
    sectionId: 'B1',
    coordinate: { x: 51270.15, y: 38860.66 },
    crackWidthMm: 2.25, // 舍入边界：2.25 → 2.3（定点四舍五入，非银行家舍入）
    detectionMethod: 'ground_penetrating_radar',
    imageSummary: '受控样本：舍入边界。',
    rectificationStatus: 'verified',
    verifiedAt: '2026-11-12T09:05:00+08:00',
    attachmentIds: [],
    semanticTags: ['rounding-boundary'],
  },
  {
    defectId: 'SB-008',
    sectionId: 'B1',
    coordinate: { x: 51280.77, y: 38870.23 },
    crackWidthMm: 14.96, // → 15.0 mm
    detectionMethod: 'crack_gauge',
    imageSummary: '受控样本：进位舍入。',
    rectificationStatus: 'rectified',
    verifiedAt: null,
    attachmentIds: [],
    semanticTags: ['normal-rounding'],
  },
];

/** 用契约格式化口径派生单条样本的投影预期（预期与实现共享同一套契约函数，再由哈希冻结） */
function buildExpectation(d: BenchmarkDefect): BenchmarkExpectation {
  const visible = REFERENCE_CONSUMER.visibleSections.includes(d.sectionId);
  const fields: BenchmarkExpectation['fields'] = [];

  const width = formatMeasure('crackWidthMm', d.crackWidthMm);
  fields.push({
    fieldKey: 'crackWidthMm',
    expectedValue: width.belowDetectionLimit ? '<LOD>' : width.value,
    expectedDisplay: width.display,
    expectedUnit: 'mm',
    expectedReasonCodes: [
      width.belowDetectionLimit
        ? ('below_detection_limit' as ReasonCode)
        : d.crackWidthMm === null
          ? ('null_meaning_preserved' as ReasonCode)
          : ('rounded_to_contract_scale' as ReasonCode),
    ],
  });

  const coord = formatCoordinate(d.coordinate);
  fields.push({
    fieldKey: 'coordinate',
    expectedValue: coord ? { x: coord.x, y: coord.y } : null,
    expectedDisplay: coord ? coord.display : '未采集坐标（null，非原点）',
    expectedUnit: 'm',
    expectedReasonCodes: d.coordinate === null ? [('null_meaning_preserved' as ReasonCode)] : [('coordinate_precision_applied' as ReasonCode)],
  });

  fields.push({
    fieldKey: 'detectionMethod',
    expectedValue: d.detectionMethod,
    expectedDisplay: enumLabel('detectionMethod', d.detectionMethod),
    expectedReasonCodes: d.detectionMethod === null ? [('null_meaning_preserved' as ReasonCode)] : [('included' as ReasonCode)],
  });

  fields.push({
    fieldKey: 'rectificationStatus',
    expectedValue: d.rectificationStatus,
    expectedDisplay: enumLabel('rectificationStatus', d.rectificationStatus),
    expectedReasonCodes: d.rectificationStatus === null ? [('null_meaning_preserved' as ReasonCode)] : [('included' as ReasonCode)],
  });

  fields.push({
    fieldKey: 'verifiedAt',
    expectedValue: d.verifiedAt,
    expectedDisplay: formatDateTime(d.verifiedAt),
    expectedReasonCodes: d.verifiedAt === null ? [('null_meaning_preserved' as ReasonCode)] : [('included' as ReasonCode)],
  });

  fields.push({
    fieldKey: 'imageSummary',
    expectedValue: d.imageSummary,
    expectedDisplay: d.imageSummary ?? '无影像摘要（null，不代表影像正常）',
    expectedReasonCodes: d.imageSummary === null ? [('null_meaning_preserved' as ReasonCode)] : [('included' as ReasonCode)],
  });

  // 聚合口径：仅可见、且宽度为量化数值的样本计入；null 与 <LOD 排除
  const countable = BENCHMARK_DEFECTS.filter((x) => {
    if (!REFERENCE_CONSUMER.visibleSections.includes(x.sectionId)) return false;
    const m = formatMeasure('crackWidthMm', x.crackWidthMm);
    return m.value !== null && !m.belowDetectionLimit;
  }).map((x) => formatMeasure('crackWidthMm', x.crackWidthMm).value as number);

  const sum = countable.reduce((a, b) => a + b, 0);
  const round1 = (v: number) => Math.round((v + Number.EPSILON) * 10) / 10;

  return {
    defectId: d.defectId,
    visible,
    fields,
    aggregation: {
      countableWidthsMm: countable,
      expectedCount: countable.length,
      expectedSumMm: round1(sum),
      expectedAvgMm: countable.length ? round1(sum / countable.length) : null,
    },
  };
}

let cached: SemanticBenchmark | null = null;

/** 构建（并缓存）冻结的基准样本集：版本 × 契约版本 × 策略指纹 × 内容哈希 */
export async function buildSemanticBenchmark(): Promise<SemanticBenchmark> {
  if (cached) return cached;
  const policyFingerprint = await computePolicyFingerprint();
  const expectations = BENCHMARK_DEFECTS.map(buildExpectation);
  const content = {
    benchmarkVersion: BENCHMARK_VERSION,
    semanticContractVersion: SEMANTIC_CONTRACT_VERSION,
    contractVersion: CONTRACT_VERSION,
    policyFingerprint,
    defects: BENCHMARK_DEFECTS,
    expectations,
  };
  const benchmarkHash = sha256HexSync(canonicalStringify(content));
  cached = {
    benchmarkVersion: BENCHMARK_VERSION,
    contractVersion: CONTRACT_VERSION,
    policyFingerprint,
    createdAt: AT_BASELINE,
    benchmarkHash,
    defects: BENCHMARK_DEFECTS,
    expectations,
  };
  return cached;
}

/** 同步读取缓存（测试/UI 先 await buildSemanticBenchmark 后使用） */
export function getCachedBenchmark(): SemanticBenchmark {
  if (!cached) throw new Error('基准样本集尚未构建，请先 await buildSemanticBenchmark()');
  return cached;
}

/** 重新计算样本集内容哈希，验证冻结样本未被改动 */
export function verifyBenchmarkHash(b: SemanticBenchmark): boolean {
  const content = {
    benchmarkVersion: b.benchmarkVersion,
    semanticContractVersion: SEMANTIC_CONTRACT_VERSION,
    contractVersion: b.contractVersion,
    policyFingerprint: b.policyFingerprint,
    defects: b.defects,
    expectations: b.expectations,
  };
  return sha256HexSync(canonicalStringify(content)) === b.benchmarkHash;
}

export function expectationOf(b: SemanticBenchmark, defectId: string): BenchmarkExpectation | undefined {
  return b.expectations.find((e) => e.defectId === defectId);
}
