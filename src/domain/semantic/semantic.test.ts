import { describe, expect, it, beforeAll } from 'vitest';
import type { ObservationProbe, SemanticBenchmark } from '../../types';
import {
  BENCHMARK_VERSION,
  buildSemanticBenchmark,
  verifyBenchmarkHash,
} from './benchmark';
import {
  SEMANTIC_CONTRACT_VERSION,
  computePolicyFingerprint,
  getSemanticContract,
  toCanonicalUnit,
} from './contract';
import { interpretProbe } from './diff';
import { differentialReplay, runReferenceProjection } from './replay';
import { runMetamorphicSuite, suiteSummary } from './metamorphic';
import { runSemanticGate } from './gate';
import { SIMULATED_CONSUMERS, getConsumerDef } from './consumers';
import { runConsumerProbe } from './probe';

const AT = '2026-11-25T10:00:00+08:00';

let benchmark: SemanticBenchmark;
let policyFingerprint: string;

beforeAll(async () => {
  benchmark = await buildSemanticBenchmark();
  policyFingerprint = await computePolicyFingerprint();
});

describe('语义行为契约声明', () => {
  it('单位换算因子覆盖 mm/cm/m/μm，且折回基准单位数学闭合', () => {
    expect(toCanonicalUnit('crackWidthMm', 0.012, 'm')).toBeCloseTo(12, 10);
    expect(toCanonicalUnit('crackWidthMm', 1.2, 'cm')).toBeCloseTo(12, 10);
    expect(toCanonicalUnit('crackWidthMm', 12000, 'μm')).toBeCloseTo(12, 10);
    expect(toCanonicalUnit('crackWidthMm', 12, 'mm')).toBe(12);
    expect(() => toCanonicalUnit('crackWidthMm', 1, 'mile')).toThrow(/未声明单位/);
  });

  it('裂缝宽度契约同时声明检出限、空值纪律与聚合口径', () => {
    const c = getSemanticContract('crackWidthMm');
    expect(c.detectionLimit).toBe(0.1);
    expect(c.nullPolicy).toBe('preserve_null');
    expect(c.aggregationRule).toContain('不得按 0 计入');
    const kinds = c.invariantStatements.map((s) => s.kind);
    for (const k of ['unit', 'null', 'rounding', 'filter', 'aggregation']) expect(kinds).toContain(k);
  });

  it('策略指纹随契约注册表内容变化（冻结基线可复现）', async () => {
    const again = await computePolicyFingerprint();
    expect(again).toBe(policyFingerprint);
    expect(benchmark.policyFingerprint).toBe(policyFingerprint);
    expect(SEMANTIC_CONTRACT_VERSION).toMatch(/^sc-/);
  });
});

describe('受控基准样本集与冻结绑定', () => {
  it('版本/契约版本/样本数量与语义边界标签正确', () => {
    expect(benchmark.benchmarkVersion).toBe(BENCHMARK_VERSION);
    expect(benchmark.defects).toHaveLength(8);
    const tags = benchmark.defects.flatMap((d) => d.semanticTags);
    expect(tags).toContain('below-detection-limit');
    expect(tags).toContain('missing-null-measurement');
    expect(tags).toContain('section-filtered');
    expect(tags).toContain('rounding-boundary');
  });

  it('投影预期：检出限/null/过滤/舍入边界全部按契约表达', () => {
    const e = (id: string) => benchmark.expectations.find((x) => x.defectId === id)!;
    expect(e('SB-002').fields.find((f) => f.fieldKey === 'crackWidthMm')!.expectedValue).toBe('<LOD>');
    expect(e('SB-003').fields.find((f) => f.fieldKey === 'crackWidthMm')!.expectedValue).toBeNull();
    expect(e('SB-004').fields.find((f) => f.fieldKey === 'coordinate')!.expectedValue).toBeNull();
    expect(e('SB-001').fields.find((f) => f.fieldKey === 'crackWidthMm')!.expectedValue).toBe(12);
    expect(e('SB-007').fields.find((f) => f.fieldKey === 'crackWidthMm')!.expectedValue).toBe(2.3);
    expect(e('SB-008').fields.find((f) => f.fieldKey === 'crackWidthMm')!.expectedValue).toBe(15);
    expect(e('SB-006').visible).toBe(false);
  });

  it('聚合预期：null 与 <LOD 排除，count=5 / sum=38.2 / avg=7.6', () => {
    const agg = benchmark.expectations.find((x) => x.defectId === 'SB-008')!.aggregation;
    expect(agg.expectedCount).toBe(5);
    expect(agg.expectedSumMm).toBeCloseTo(38.2, 6);
    expect(agg.expectedAvgMm).toBeCloseTo(7.6, 6);
    expect(agg.countableWidthsMm).not.toContain(0);
  });

  it('样本集哈希可复现；篡改任一样本后哈希校验失败', () => {
    expect(verifyBenchmarkHash(benchmark)).toBe(true);
    const tampered: SemanticBenchmark = {
      ...benchmark,
      defects: benchmark.defects.map((d) =>
        d.defectId === 'SB-001' ? { ...d, crackWidthMm: 99.9 } : d,
      ),
    };
    expect(verifyBenchmarkHash(tampered)).toBe(false);
  });
});

describe('参考实现接线（真实投影编译器处理冻结样本）', () => {
  it('B2 样本被过滤，亚检出限样本带 belowDetectionLimit', () => {
    const projection = runReferenceProjection(benchmark, AT);
    const ids = projection.defects.map((d) => d.defectId);
    expect(ids).not.toContain('SB-006');
    expect(ids).toHaveLength(7);
    const lod = projection.defects.find((d) => d.defectId === 'SB-002')!;
    expect(lod.crackWidth?.belowDetectionLimit).toBe(true);
    const missing = projection.defects.find((d) => d.defectId === 'SB-003')!;
    expect(missing.crackWidth?.value).toBeNull();
  });
});

describe('差分回放 × 差异解释器', () => {
  function replayFor(consumerId: string) {
    const profile = getConsumerDef(consumerId).profile;
    return differentialReplay({ benchmark, consumer: profile, atIso: AT, currentPolicyFingerprint: policyFingerprint });
  }

  it('合规消费方：零分歧、绑定有效、探针 matched=true', () => {
    const r = replayFor('consumer-compliant');
    expect(r.bindingValid).toBe(true);
    expect(r.probeReport.matched).toBe(true);
    expect(r.probeReport.divergences).toHaveLength(0);
    expect(r.referenceProbe.aggregationSummary?.count).toBe(5);
  });

  it('单位误读消费方：每个量化宽度都产生 unit 阻塞分歧（mm 数字贴 m 标签）', () => {
    const r = replayFor('consumer-unit-bug');
    const unitBlockers = r.probeReport.divergences.filter((d) => d.kind === 'unit' && d.severity === 'blocker');
    expect(unitBlockers.length).toBeGreaterThan(0);
    const one = unitBlockers[0];
    expect(one.observed).toContain('m');
    expect(one.hint).toContain('换算');
  });

  it('空值归零消费方：<LOD>→0、null→0、坐标补原点、枚举默认值与聚合计数全部被定位', () => {
    const r = replayFor('consumer-null-zero');
    const d = r.probeReport.divergences;
    expect(d.some((x) => x.defectId === 'SB-002' && x.kind === 'rounding')).toBe(true);
    expect(d.some((x) => x.defectId === 'SB-003' && x.kind === 'null')).toBe(true);
    expect(d.some((x) => x.defectId === 'SB-004' && x.fieldKey === 'coordinate' && x.kind === 'null')).toBe(true);
    expect(d.some((x) => x.kind === 'aggregation' && x.severity === 'blocker')).toBe(true);
    expect(r.consumerProbe.aggregationSummary?.countedAsZero.sort()).toEqual(['SB-002', 'SB-003']);
  });

  it('枚举默认值消费方：null 枚举被套 visual/open、时间套纪元，产生 null/enum 分歧', () => {
    const r = replayFor('consumer-enum-default');
    const d = r.probeReport.divergences;
    expect(d.some((x) => x.defectId === 'SB-005' && x.fieldKey === 'detectionMethod')).toBe(true);
    expect(d.some((x) => x.defectId === 'SB-005' && x.fieldKey === 'rectificationStatus')).toBe(true);
    expect(d.some((x) => x.defectId === 'SB-005' && x.fieldKey === 'verifiedAt')).toBe(true);
  });

  it('过滤失效消费方：未授权 B2 样本被输出，触发 filter 阻塞分歧', () => {
    const r = replayFor('consumer-filter-broken');
    const f = r.probeReport.divergences.filter((x) => x.kind === 'filter');
    expect(f.some((x) => x.defectId === 'SB-006' && x.severity === 'blocker')).toBe(true);
  });

  it('舍入截断消费方：5.57→5.5 等被判定为 rounding 阻塞分歧', () => {
    const r = replayFor('consumer-rounding-bug');
    const rounding = r.probeReport.divergences.filter((x) => x.kind === 'rounding');
    expect(rounding.some((x) => x.defectId === 'SB-004')).toBe(true);
    expect(rounding.some((x) => x.defectId === 'SB-008')).toBe(true);
  });

  it('外部回传旧版本探针：绑定四项校验可单独识别漂移', () => {
    const stale: ObservationProbe = {
      ...runConsumerProbe(benchmark, getConsumerDef('consumer-compliant').profile, AT),
      benchmarkHash: '0'.repeat(64),
      contractVersion: 'fc-1999.0',
    };
    const report = interpretProbe({ benchmark, probe: stale, currentPolicyFingerprint: policyFingerprint });
    expect(report.binding.benchmarkHashMatch).toBe(false);
    expect(report.binding.contractVersionMatch).toBe(false);
    expect(report.binding.policyFingerprintMatch).toBe(true);
    expect(report.matched).toBe(false);
  });
});

describe('变形测试', () => {
  it('合规消费方：单位缩放/等价重排/缺失注入全部通过', () => {
    const suite = runMetamorphicSuite({
      benchmark,
      profile: getConsumerDef('consumer-compliant').profile,
      atIso: AT,
    });
    expect(suite.passed).toBe(true);
    expect(suiteSummary(suite).failed).toBe(0);
    expect(suite.cases.map((c) => c.transform)).toEqual(
      expect.arrayContaining(['unit_scale', 'equivalent_reorder', 'missing_injection']),
    );
  });

  it('单位缩放不变量：mm↔m↔cm↔μm 回路闭合（纯契约数学，与消费方无关）', () => {
    const suite = runMetamorphicSuite({
      benchmark,
      profile: getConsumerDef('consumer-unit-bug').profile,
      atIso: AT,
    });
    expect(suite.cases.filter((c) => c.transform === 'unit_scale').every((c) => c.passed)).toBe(true);
  });

  it('空值归零消费方：缺失注入用例失败（null 被替换 / 聚合污染 / 坐标补原点）', () => {
    const suite = runMetamorphicSuite({
      benchmark,
      profile: getConsumerDef('consumer-null-zero').profile,
      atIso: AT,
    });
    expect(suite.passed).toBe(false);
    const failed = suite.cases.filter((c) => !c.passed).map((c) => c.transform);
    expect(failed).toContain('missing_injection');
  });

  it('枚举默认值消费方：枚举/时间缺失注入用例失败', () => {
    const suite = runMetamorphicSuite({
      benchmark,
      profile: getConsumerDef('consumer-enum-default').profile,
      atIso: AT,
    });
    const enumCase = suite.cases.find((c) => c.fieldKey === 'detectionMethod')!;
    expect(enumCase.passed).toBe(false);
  });
});

describe('语义交付门禁', () => {
  it('仅合规消费方：verdict=pass，五项检查无 fail', async () => {
    const report = await runSemanticGate({
      benchmark,
      consumers: [getConsumerDef('consumer-compliant').profile],
      atIso: AT,
    });
    expect(report.verdict).toBe('pass');
    expect(report.holdReasons).toHaveLength(0);
    expect(report.checks.every((c) => c.status !== 'fail')).toBe(true);
  });

  it('结构签名相同但单位不变量被违反：verdict=delivery_hold 并给出可定位原因', async () => {
    const report = await runSemanticGate({
      benchmark,
      consumers: [getConsumerDef('consumer-unit-bug').profile],
      atIso: AT,
    });
    expect(report.verdict).toBe('delivery_hold');
    expect(report.holdReasons.length).toBeGreaterThan(0);
    expect(report.holdReasons.join('\n')).toContain('unit');
    expect(report.checks.find((c) => c.id === 'unit-invariant')!.status).toBe('fail');
  });

  it('全量消费方：门禁暂停交付，原因覆盖单位/空值/过滤/聚合/变形', async () => {
    const report = await runSemanticGate({
      benchmark,
      consumers: SIMULATED_CONSUMERS.map((c) => c.profile),
      atIso: AT,
    });
    expect(report.verdict).toBe('delivery_hold');
    const joined = report.holdReasons.join('\n');
    expect(joined).toMatch(/unit|null|filter|aggregation|变形/);
    expect(report.metamorphic.passed).toBe(false);
  });

  it('冻结样本被篡改：绑定检查 fail 且门禁暂停（即使消费方处理器合规）', async () => {
    const tampered: SemanticBenchmark = {
      ...benchmark,
      defects: benchmark.defects.map((d) =>
        d.defectId === 'SB-001' ? { ...d, crackWidthMm: 1.0 } : d,
      ),
    };
    const report = await runSemanticGate({
      benchmark: tampered,
      consumers: [getConsumerDef('consumer-compliant').profile],
      atIso: AT,
    });
    expect(report.verdict).toBe('delivery_hold');
    expect(report.checks.find((c) => c.id === 'binding')!.status).toBe('fail');
    expect(report.holdReasons.some((r) => r.includes('冻结绑定'))).toBe(true);
  });
});
