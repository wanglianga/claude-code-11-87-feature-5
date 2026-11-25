import type { BenchmarkDefect, FieldObservation, ObservationProbe } from '../../types';
import { enumLabel, formatCoordinate, formatDateTime, formatMeasure, roundToScale } from '../format';
import type { ConsumerProfile } from './probe';
import { REFERENCE_CONSUMER } from './benchmark';

// ============================================================
// 模拟消费方注册表
// 结构签名（字段名/JSON 结构）在所有消费方之间完全相同，
// 差异只在“怎么解释”单位、空值、检出限、枚举与过滤——
// 这正是结构校验发现不了、语义门禁必须拦截的问题。
// ============================================================

const inScope = (d: BenchmarkDefect) => REFERENCE_CONSUMER.visibleSections.includes(d.sectionId);

const coordValue = (d: BenchmarkDefect): { x: string; y: string } => {
  if (!d.coordinate) return { x: '0.0', y: '0.0' };
  const f = formatCoordinate(d.coordinate)!;
  return { x: f.x, y: f.y };
};

interface ConsumerDef {
  id: string;
  name: string;
  description: string;
  profile: ConsumerProfile;
}

// ---------------- 1) 契约合规消费方（绿灯基线） ----------------

const compliantHandler = (d: BenchmarkDefect): FieldObservation[] => {
  if (!inScope(d)) return [];
  const w = formatMeasure('crackWidthMm', d.crackWidthMm);
  const c = formatCoordinate(d.coordinate);
  return [
    {
      defectId: d.defectId,
      fieldKey: 'crackWidthMm',
      observedValue: w.belowDetectionLimit ? '<LOD>' : w.value,
      observedDisplay: w.display,
      observedUnit: 'mm',
      receivedUnit: 'mm',
      reasonCodes: [
        w.belowDetectionLimit ? 'below_detection_limit' : d.crackWidthMm === null ? 'null_meaning_preserved' : 'rounded_to_contract_scale',
      ],
    },
    {
      defectId: d.defectId,
      fieldKey: 'coordinate',
      observedValue: c ? { x: c.x, y: c.y } : null,
      observedDisplay: c ? c.display : '未采集坐标（null，非原点）',
      observedUnit: 'm',
      receivedUnit: 'm',
    },
    {
      defectId: d.defectId,
      fieldKey: 'detectionMethod',
      observedValue: d.detectionMethod,
      observedDisplay: enumLabel('detectionMethod', d.detectionMethod),
    },
    {
      defectId: d.defectId,
      fieldKey: 'rectificationStatus',
      observedValue: d.rectificationStatus,
      observedDisplay: enumLabel('rectificationStatus', d.rectificationStatus),
    },
    {
      defectId: d.defectId,
      fieldKey: 'verifiedAt',
      observedValue: d.verifiedAt,
      observedDisplay: formatDateTime(d.verifiedAt),
    },
    {
      defectId: d.defectId,
      fieldKey: 'imageSummary',
      observedValue: d.imageSummary,
      observedDisplay: d.imageSummary ?? '无影像摘要（null，不代表影像正常）',
    },
  ];
};

const compliantAggregation = (defects: BenchmarkDefect[]): ObservationProbe['aggregationSummary'] => {
  const vals = defects
    .filter(inScope)
    .map((d) => formatMeasure('crackWidthMm', d.crackWidthMm))
    .filter((m) => m.value !== null && !m.belowDetectionLimit)
    .map((m) => m.value as number);
  const sum = roundToScale(vals.reduce((a, b) => a + b, 0), 1);
  return { countedAsZero: [], sumMm: sum, count: vals.length, avgMm: vals.length ? roundToScale(sum / vals.length, 1) : null };
};

// ---------------- 2) 单位误读消费方：mm 字段当 m，数字不换算 ----------------

const unitBugHandler = (d: BenchmarkDefect): FieldObservation[] =>
  compliantHandler(d).map((o) =>
    o.fieldKey === 'crackWidthMm' && typeof o.observedValue === 'number'
      ? { ...o, observedUnit: 'm', receivedUnit: 'm', observedDisplay: `${o.observedValue} m` }
      : o,
  );

// ---------------- 3) 空值归零消费方：null→0、<LOD→toFixed(1)=0.0，并按 0 入统 ----------------

const nullAsZeroHandler = (d: BenchmarkDefect): FieldObservation[] => {
  if (!inScope(d)) return [];
  const rawWidth = d.crackWidthMm;
  const zeroed = rawWidth === null ? 0 : roundToScale(rawWidth, 1); // 0.04 先舍入 → 0
  return [
    {
      defectId: d.defectId,
      fieldKey: 'crackWidthMm',
      observedValue: zeroed,
      observedDisplay: `${zeroed.toFixed(1)} mm`,
      observedUnit: 'mm',
      receivedUnit: 'mm',
    },
    {
      defectId: d.defectId,
      fieldKey: 'coordinate',
      observedValue: coordValue(d),
      observedDisplay: d.coordinate ? formatCoordinate(d.coordinate)!.display : '(0.0, 0.0) m',
      observedUnit: 'm',
      receivedUnit: 'm',
    },
    {
      defectId: d.defectId,
      fieldKey: 'detectionMethod',
      observedValue: d.detectionMethod ?? 'visual', // 未记录臆造成“目视”
      observedDisplay: enumLabel('detectionMethod', d.detectionMethod ?? 'visual'),
    },
    {
      defectId: d.defectId,
      fieldKey: 'rectificationStatus',
      observedValue: d.rectificationStatus ?? 'open', // 未填报误判为“未整改”
      observedDisplay: enumLabel('rectificationStatus', d.rectificationStatus ?? 'open'),
    },
    {
      defectId: d.defectId,
      fieldKey: 'verifiedAt',
      observedValue: d.verifiedAt ?? '1970-01-01T00:00:00Z', // 纪元时间伪装
      observedDisplay: d.verifiedAt ? formatDateTime(d.verifiedAt) : '1970-01-01 00:00',
    },
    {
      defectId: d.defectId,
      fieldKey: 'imageSummary',
      observedValue: d.imageSummary ?? '影像正常',
      observedDisplay: d.imageSummary ?? '影像正常',
    },
  ];
};

const nullAsZeroAggregation = (defects: BenchmarkDefect[]): ObservationProbe['aggregationSummary'] => {
  const rows = defects.filter(inScope).map((d) => ({
    id: d.defectId,
    v: d.crackWidthMm === null ? 0 : roundToScale(d.crackWidthMm, 1),
    misZero: d.crackWidthMm === null || d.crackWidthMm < 0.1,
  }));
  const sum = roundToScale(rows.reduce((a, r) => a + r.v, 0), 1);
  return {
    countedAsZero: rows.filter((r) => r.misZero).map((r) => r.id),
    sumMm: sum,
    count: rows.length,
    avgMm: roundToScale(sum / rows.length, 1),
  };
};

// ---------------- 4) 枚举默认值消费方：null 枚举套默认、时间套纪元 ----------------

const enumDefaultHandler = (d: BenchmarkDefect): FieldObservation[] =>
  compliantHandler(d).map((o) => {
    if (o.fieldKey === 'detectionMethod' && d.detectionMethod === null) {
      return { ...o, observedValue: 'visual', observedDisplay: enumLabel('detectionMethod', 'visual') };
    }
    if (o.fieldKey === 'rectificationStatus' && d.rectificationStatus === null) {
      return { ...o, observedValue: 'open', observedDisplay: enumLabel('rectificationStatus', 'open') };
    }
    if (o.fieldKey === 'verifiedAt' && d.verifiedAt === null) {
      return { ...o, observedValue: '1970-01-01T00:00:00Z', observedDisplay: '1970-01-01 00:00' };
    }
    return o;
  });

// ---------------- 5) 过滤失效消费方：不做标段交集，B2 也输出 ----------------

const filterBrokenHandler = (d: BenchmarkDefect): FieldObservation[] => compliantHandler({ ...d, sectionId: 'B1' });

// ---------------- 6) 舍入缺陷消费方：截断代替四舍五入 ----------------

const truncate1 = (v: number) => Math.floor((v + Number.EPSILON) * 10) / 10;

const roundingBugHandler = (d: BenchmarkDefect): FieldObservation[] =>
  compliantHandler(d).map((o) => {
    if (o.fieldKey === 'crackWidthMm' && typeof d.crackWidthMm === 'number' && d.crackWidthMm >= 0.1) {
      const v = truncate1(d.crackWidthMm);
      return { ...o, observedValue: v, observedDisplay: `${v.toFixed(1)} mm` };
    }
    return o;
  });

export const SIMULATED_CONSUMERS: ConsumerDef[] = [
  {
    id: 'consumer-compliant',
    name: '合规消费方（按契约解释）',
    description: '单位、检出限、空值、枚举与过滤全部遵守语义契约，应全绿通过。',
    profile: { consumerId: 'consumer-compliant', consumerName: '合规消费方', handler: compliantHandler, aggregation: compliantAggregation },
  },
  {
    id: 'consumer-unit-bug',
    name: '单位误读消费方（mm 当 m）',
    description: '结构完全相同，但把毫米数字贴米标签且不换算，违反单位换算不变量。',
    profile: { consumerId: 'consumer-unit-bug', consumerName: '单位误读消费方', handler: unitBugHandler, aggregation: compliantAggregation },
  },
  {
    id: 'consumer-null-zero',
    name: '空值归零消费方',
    description: 'null 与 <检出限 全部变成 0 并按 0 入统，坐标 null 补原点，违反空值/检出限/聚合不变量。',
    profile: { consumerId: 'consumer-null-zero', consumerName: '空值归零消费方', handler: nullAsZeroHandler, aggregation: nullAsZeroAggregation },
  },
  {
    id: 'consumer-enum-default',
    name: '枚举默认值消费方',
    description: 'null 枚举被套上 visual/open 默认值，null 时间被套上纪元时间，违反枚举/空值不变量。',
    profile: { consumerId: 'consumer-enum-default', consumerName: '枚举默认值消费方', handler: enumDefaultHandler, aggregation: compliantAggregation },
  },
  {
    id: 'consumer-filter-broken',
    name: '过滤失效消费方',
    description: '不做标段授权交集，把未授权 B2 样本也输出，违反过滤不变量。',
    profile: { consumerId: 'consumer-filter-broken', consumerName: '过滤失效消费方', handler: filterBrokenHandler, aggregation: compliantAggregation },
  },
  {
    id: 'consumer-rounding-bug',
    name: '舍入截断消费方',
    description: '用截断代替定点四舍五入（5.57→5.5），违反舍入不变量。',
    profile: { consumerId: 'consumer-rounding-bug', consumerName: '舍入截断消费方', handler: roundingBugHandler, aggregation: compliantAggregation },
  },
];

export function getConsumerDef(id: string): ConsumerDef {
  const c = SIMULATED_CONSUMERS.find((x) => x.id === id);
  if (!c) throw new Error(`未注册的模拟消费方: ${id}`);
  return c;
}
