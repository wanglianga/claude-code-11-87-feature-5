import type {
  BenchmarkDefect,
  FieldObservation,
  MetamorphicCase,
  MetamorphicSuiteReport,
  ObservationProbe,
  SemanticBenchmark,
} from '../../types';
import { uid } from '../hash';
import { getSemanticContract, toCanonicalUnit } from './contract';
import type { ConsumerProfile } from './probe';

// ============================================================
// 变形测试（Metamorphic Testing）
// 不依赖“已知正确答案”，而是对输入施加【语义等价变换】，断言输出不变量：
//   1) unit_scale         单位缩放：同一测量换单位表达，折算回基准单位必须不变；
//   2) equivalent_reorder 等价重排：样本顺序重排，逐实体结果与聚合口径必须不变；
//   3) missing_injection  缺失注入：注入 null，空值语义必须保留且聚合排除空值。
// 优点：接入轻，任何消费方处理器都能跑；代价：只能证明不变量被违反，
// 根因定位需要结合差分回放的差异解释器。
// ============================================================

const EPS = 1e-9;
const approx = (a: number, b: number) => Math.abs(a - b) <= EPS;

/** 变形测试要求消费方必须回传聚合摘要；缺失即视为处理器不合规并快速失败 */
function aggOf(profile: ConsumerProfile, defects: BenchmarkDefect[]): NonNullable<ObservationProbe['aggregationSummary']> {
  const agg = profile.aggregation(defects);
  if (!agg) throw new Error(`消费方 ${profile.consumerId} 未回传聚合摘要，无法执行聚合不变量验证`);
  return agg;
}

function mc(
  transform: MetamorphicCase['transform'],
  fieldKey: string,
  title: string,
  description: string,
  invariantKind: MetamorphicCase['invariantKind'],
  passed: boolean,
  expected: string,
  observed: string,
  detail: string,
): MetamorphicCase {
  return {
    caseId: uid('MM'),
    transform,
    title,
    fieldKey,
    description,
    invariantKind,
    passed,
    expected,
    observed,
    detail,
  };
}

/** 单位缩放不变量：canonical = received × factor，换单位表达同一测量，基准值不变 */
function unitScaleCases(): MetamorphicCase[] {
  const out: MetamorphicCase[] = [];
  for (const fieldKey of ['crackWidthMm', 'coordinate'] as const) {
    const contract = getSemanticContract(fieldKey);
    if (!contract.canonicalUnit || !contract.unitConversions) continue;
    const canonicalSample = fieldKey === 'crackWidthMm' ? 12.03 : 51230.46;
    const lines: string[] = [];
    let allPass = true;
    for (const conv of contract.unitConversions) {
      if (conv.unit === contract.canonicalUnit) continue;
      // 同一测量以 conv.unit 表达：received = canonical / factor
      const received = canonicalSample / conv.factor;
      const back = toCanonicalUnit(fieldKey, received, conv.unit);
      const ok = approx(back, canonicalSample);
      if (!ok) allPass = false;
      lines.push(`${canonicalSample} ${contract.canonicalUnit} = ${received} ${conv.unit} → 折算 ${back}`);
    }
    out.push(
      mc(
        'unit_scale',
        fieldKey,
        `单位缩放不变量 · ${contract.label}`,
        `对 ${fieldKey} 的全部声明单位逐一缩放表达，再按换算因子折回基准单位 ${contract.canonicalUnit}。`,
        'unit',
        allPass,
        `折回基准单位恒等于 ${canonicalSample} ${contract.canonicalUnit}`,
        allPass ? '全部换算回路闭合' : '存在换算回路不闭合',
        lines.join('；'),
      ),
    );
  }
  return out;
}

function obsKey(o: FieldObservation): string {
  return `${o.defectId}|${o.fieldKey}|${JSON.stringify(o.observedValue)}|${o.observedUnit ?? ''}|${o.omitted ?? false}`;
}

/** 等价重排不变量：顺序变化不影响逐实体语义与聚合口径 */
function reorderCases(benchmark: SemanticBenchmark, profile: ConsumerProfile): MetamorphicCase[] {
  const original = benchmark.defects;
  // 确定性重排：先逆序，再两两相邻交换，避免随机数且保证仍是同一集合的排列
  const reversed = [...original].reverse();
  const reordered: BenchmarkDefect[] = [];
  for (let i = 0; i < reversed.length; i += 2) {
    if (i + 1 < reversed.length) reordered.push(reversed[i + 1], reversed[i]);
    else reordered.push(reversed[i]);
  }

  const obsA = original.flatMap((d) => profile.handler(d)).map(obsKey).sort();
  const obsB = reordered.flatMap((d) => profile.handler(d)).map(obsKey).sort();
  const samePerEntity = JSON.stringify(obsA) === JSON.stringify(obsB);

  const aggA = aggOf(profile, original);
  const aggB = aggOf(profile, reordered);
  const sameAgg =
    aggA.count === aggB.count &&
    approx(aggA.sumMm, aggB.sumMm) &&
    (aggA.avgMm ?? null) === (aggB.avgMm ?? null) &&
    JSON.stringify([...aggA.countedAsZero].sort()) === JSON.stringify([...aggB.countedAsZero].sort());

  return [
    mc(
      'equivalent_reorder',
      '*',
      '等价重排 · 逐实体结果不变',
      '把冻结样本逆序并做相邻交换后重跑消费方处理器，每个“实体 × 字段”的观测必须与原顺序完全一致。',
      'filter',
      samePerEntity,
      `观测集合一致（${obsA.length} 项）`,
      samePerEntity ? '一致' : '重排后观测发生变化',
      samePerEntity ? '处理器对样本顺序不敏感。' : '消费方处理依赖输入顺序，存在顺序耦合缺陷。',
    ),
    mc(
      'equivalent_reorder',
      'crackWidthMm',
      '等价重排 · 聚合口径不变',
      '重排前后聚合计数 / 合计 / 均值 / 空值处理名单必须完全一致。',
      'aggregation',
      sameAgg,
      `count=${aggA.count} sum=${aggA.sumMm} avg=${aggA.avgMm ?? 'null'}`,
      `count=${aggB.count} sum=${aggB.sumMm} avg=${aggB.avgMm ?? 'null'}`,
      sameAgg ? '聚合与顺序无关。' : '聚合结果随顺序变化，口径不稳定。',
    ),
  ];
}

function cloneWith(id: string, d: BenchmarkDefect, patch: Partial<BenchmarkDefect>): BenchmarkDefect {
  return { ...d, defectId: id, semanticTags: [...d.semanticTags, 'metamorphic-injection'], ...patch };
}

function findObs(rows: FieldObservation[], defectId: string, fieldKey: string) {
  return rows.find((o) => o.defectId === defectId && o.fieldKey === fieldKey);
}

/** 缺失注入不变量：null 必须保留语义、不得补默认值，且聚合排除空值 */
function missingInjectionCases(benchmark: SemanticBenchmark, profile: ConsumerProfile): MetamorphicCase[] {
  const donor = benchmark.defects.find((d) => d.defectId === 'SB-001')!;
  const baselineAgg = aggOf(profile, benchmark.defects);

  // 1) 宽度测量缺失注入
  const widthMissing = cloneWith('SB-INJECT-NULL-WIDTH', donor, { crackWidthMm: null });
  const widthRows = profile.handler(widthMissing);
  const widthObs = findObs(widthRows, widthMissing.defectId, 'crackWidthMm');
  const widthNullKept = widthObs?.observedValue === null;
  const aggAfterWidth = aggOf(profile, [...benchmark.defects, widthMissing]);
  const widthAggExcluded =
    aggAfterWidth.count === baselineAgg.count && approx(aggAfterWidth.sumMm, baselineAgg.sumMm);

  // 2) 坐标缺失注入（null ≠ 原点）
  const coordMissing = cloneWith('SB-INJECT-NULL-COORD', donor, { coordinate: null });
  const coordObs = findObs(profile.handler(coordMissing), coordMissing.defectId, 'coordinate');
  const coordNullKept = coordObs?.observedValue === null;

  // 3) 枚举缺失注入（null ≠ 默认枚举 / 纪元时间）
  const enumMissing = cloneWith('SB-INJECT-NULL-ENUM', donor, {
    detectionMethod: null,
    rectificationStatus: null,
    verifiedAt: null,
  });
  const enumRows = profile.handler(enumMissing);
  const methodNull = findObs(enumRows, enumMissing.defectId, 'detectionMethod')?.observedValue === null;
  const statusNull = findObs(enumRows, enumMissing.defectId, 'rectificationStatus')?.observedValue === null;
  const timeNull = findObs(enumRows, enumMissing.defectId, 'verifiedAt')?.observedValue === null;
  const enumNullKept = methodNull && statusNull && timeNull;

  return [
    mc(
      'missing_injection',
      'crackWidthMm',
      '缺失注入 · 测量 null 保留且排除出聚合',
      '复制一条量化样本并把裂缝宽度注入为 null：输出必须仍是 null（不得变 0），聚合计数不增、合计不变。',
      'null',
      widthNullKept && widthAggExcluded,
      '观测值 null；聚合 count 不增、sum 不变',
      `观测值=${String(widthObs?.observedValue)}；count ${baselineAgg.count}→${aggAfterWidth.count}，sum ${baselineAgg.sumMm}→${aggAfterWidth.sumMm}`,
      widthNullKept
        ? widthAggExcluded
          ? 'null 语义保留且未污染聚合。'
          : 'null 虽保留但被错误计入聚合分母。'
        : 'null 被替换成具体值（典型为 0），空值语义被破坏。',
    ),
    mc(
      'missing_injection',
      'coordinate',
      '缺失注入 · 坐标 null ≠ 原点',
      '复制样本并把坐标注入为 null：输出必须是 null，禁止补成 (0.0, 0.0)。',
      'null',
      coordNullKept,
      '观测值 null（未采集，非原点）',
      `观测值=${JSON.stringify(coordObs?.observedValue ?? '缺省')}`,
      coordNullKept ? '坐标空值语义保留。' : '未采集坐标被补成原点或其他值。',
    ),
    mc(
      'missing_injection',
      'detectionMethod',
      '缺失注入 · 枚举/时间 null 不套默认值',
      '把检测方法、整改状态、核验时间同时注入 null：三个字段都必须保留 null，不得映射 visual/open/纪元时间。',
      'enum',
      enumNullKept,
      '三个字段观测值均为 null',
      `method=${String(methodNull)}, status=${String(statusNull)}, verifiedAt=${String(timeNull)}`,
      enumNullKept ? '枚举与时间空值语义保留。' : '至少一个 null 字段被套上默认值或纪元时间。',
    ),
  ];
}

export interface MetamorphicRunArgs {
  benchmark: SemanticBenchmark;
  profile: ConsumerProfile;
  atIso: string;
}

export function runMetamorphicSuite(args: MetamorphicRunArgs): MetamorphicSuiteReport {
  const { benchmark, profile, atIso } = args;
  const cases: MetamorphicCase[] = [
    ...unitScaleCases(),
    ...reorderCases(benchmark, profile),
    ...missingInjectionCases(benchmark, profile),
  ];
  const report: MetamorphicSuiteReport = {
    suiteId: uid('MMS'),
    benchmarkVersion: benchmark.benchmarkVersion,
    contractVersion: benchmark.contractVersion,
    ranAt: atIso,
    cases,
    passed: cases.every((c) => c.passed),
  };
  return report;
}

/** 变形测试通过率（UI 进度展示用） */
export function suiteSummary(report: MetamorphicSuiteReport): { total: number; passed: number; failed: number } {
  return {
    total: report.cases.length,
    passed: report.cases.filter((c) => c.passed).length,
    failed: report.cases.filter((c) => !c.passed).length,
  };
}
