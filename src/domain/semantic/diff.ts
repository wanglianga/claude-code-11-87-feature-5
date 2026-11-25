import type {
  BenchmarkExpectation,
  FieldObservation,
  InvariantKind,
  ObservationProbe,
  ProbeReport,
  SemanticBenchmark,
  SemanticDivergence,
} from '../../types';
import { uid } from '../hash';
import { getSemanticContract, toCanonicalUnit } from './contract';

// ============================================================
// 差异解释器（Divergence Interpreter）
// 把探针观测与冻结样本的投影预期逐“实体 × 字段 × 不变量”比对，
// 输出可定位的语义分歧：单位换算 / 空值 / 舍入(含检出限) / 枚举 / 过滤 / 聚合。
// blocker 级分歧会被交付门禁直接判定为“暂停交付”。
// ============================================================

type Severity = SemanticDivergence['severity'];

function divergence(
  kind: InvariantKind,
  defectId: string,
  fieldKey: string,
  severity: Severity,
  expected: unknown,
  observed: unknown,
  explanation: string,
  hint: string,
): SemanticDivergence {
  return {
    divergenceId: uid('DVG'),
    kind,
    defectId,
    fieldKey,
    severity,
    expected: String(expected),
    observed: String(observed),
    explanation,
    hint,
  };
}

function findObservation(obs: FieldObservation[], defectId: string, fieldKey: string) {
  return obs.find((o) => o.defectId === defectId && o.fieldKey === fieldKey);
}

function approxEqual(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

/** 把观测值折算到契约基准单位后返回数值；非数值返回 null */
function observedCanonicalNumber(fieldKey: string, o: FieldObservation): number | null {
  if (typeof o.observedValue !== 'number') return null;
  const contract = getSemanticContract(fieldKey);
  if (!contract.canonicalUnit || !o.receivedUnit || o.receivedUnit === contract.canonicalUnit) {
    return o.observedValue;
  }
  return toCanonicalUnit(fieldKey, o.observedValue, o.receivedUnit);
}

export interface InterpretArgs {
  benchmark: SemanticBenchmark;
  probe: ObservationProbe;
  /** 当前实时策略指纹（由门禁计算后传入，用于冻结绑定校验） */
  currentPolicyFingerprint: string;
}

export function interpretProbe(args: InterpretArgs): ProbeReport {
  const { benchmark, probe, currentPolicyFingerprint } = args;
  const divergences: SemanticDivergence[] = [];
  let totalChecks = 0;

  for (const exp of benchmark.expectations) {
    const defectObservations = probe.observations.filter((o) => o.defectId === exp.defectId);

    // ---------- 过滤不变量：预期不可见的实体必须整体缺省 ----------
    if (!exp.visible) {
      totalChecks += 1;
      if (defectObservations.length > 0) {
        divergences.push(
          divergence(
            'filter',
            exp.defectId,
            '*',
            'blocker',
            '实体不在授权标段，投影中必须整体缺省',
            `消费方输出了 ${defectObservations.length} 个字段`,
            `样本 ${exp.defectId} 属于未授权标段，消费方未执行标段过滤。`,
            '在消费侧先做授权标段交集，再做字段映射；未通过交集的实体不得进入结果集。',
          ),
        );
      }
      continue;
    }

    // ---------- 预期可见：逐字段比对 ----------
    for (const f of exp.fields) {
      totalChecks += 1;
      const o = findObservation(probe.observations, exp.defectId, f.fieldKey);
      if (!o || o.omitted) {
        divergences.push(
          divergence(
            'filter',
            exp.defectId,
            f.fieldKey,
            'blocker',
            f.expectedDisplay,
            '字段缺省（omitted）',
            `授权画像下 ${f.fieldKey} 应当可见，消费方却缺省该字段，疑似把授权字段错误过滤或用默认值逻辑吞掉。`,
            '核对消费方字段组授权映射；契约可见且授权通过的字段不得缺省。',
          ),
        );
        continue;
      }

      compareField(f, o, divergences);
    }

    // ---------- 聚合不变量 ----------
    totalChecks += 1;
    const summary = probe.aggregationSummary;
    if (summary) {
      if (summary.countedAsZero.includes(exp.defectId)) {
        divergences.push(
          divergence(
            'aggregation',
            exp.defectId,
            'crackWidthMm',
            'blocker',
            'null / <检出限 读数排除在求和与计数分母之外',
            '消费方将该样本按 0 计入聚合',
            '消费方把语义空值或亚检出限读数当成数值 0 参与统计，污染均值/合计。',
            '聚合前先按契约分流：量化读数才计入；null 与 <LOD 单独计数、不进数值合计。',
          ),
        );
      }
      if (exp === benchmark.expectations.filter((e) => e.visible).at(-1)!) {
        // 仅在最后一条可见样本上做一次整体聚合口径核对
        const agg = exp.aggregation;
        if (summary.count !== agg.expectedCount) {
          divergences.push(
            divergence(
              'aggregation',
              '*',
              'crackWidthMm',
              'blocker',
              `可计入样本数 ${agg.expectedCount}`,
              `消费方计数 ${summary.count}`,
              '聚合计数口径与契约不一致（null / <LOD / 被过滤实体的处理错误）。',
              '计数分母只包含可见且已量化的读数。',
            ),
          );
        }
        if (!approxEqual(summary.sumMm, agg.expectedSumMm, 0.11)) {
          divergences.push(
            divergence(
              'aggregation',
              '*',
              'crackWidthMm',
              'blocker',
              `契约口径合计 ${agg.expectedSumMm} mm`,
              `消费方合计 ${summary.sumMm} mm`,
              '裂缝宽度合计与契约口径不符，通常是空值按 0 计入或单位未换算。',
              '按契约单位与空值纪律重算合计。',
            ),
          );
        }
        if (
          (agg.expectedAvgMm === null) !== (summary.avgMm === null) ||
          (agg.expectedAvgMm !== null &&
            summary.avgMm !== null &&
            !approxEqual(summary.avgMm, agg.expectedAvgMm, 0.11))
        ) {
          divergences.push(
            divergence(
              'aggregation',
              '*',
              'crackWidthMm',
              'major',
              `契约口径均值 ${agg.expectedAvgMm ?? 'null'} mm`,
              `消费方均值 ${summary.avgMm ?? 'null'} mm`,
              '均值口径与契约不一致。',
              '均值 = 量化读数合计 / 量化读数计数，排除 null 与 <LOD。',
            ),
          );
        }
      }
    }
  }

  const binding = {
    benchmarkVersionMatch: probe.benchmarkVersion === benchmark.benchmarkVersion,
    benchmarkHashMatch: probe.benchmarkHash === benchmark.benchmarkHash,
    contractVersionMatch: probe.contractVersion === benchmark.contractVersion,
    policyFingerprintMatch: currentPolicyFingerprint === benchmark.policyFingerprint,
  };

  return {
    probeId: probe.probeId,
    consumerId: probe.consumerId,
    benchmarkVersion: benchmark.benchmarkVersion,
    matched: divergences.length === 0 && Object.values(binding).every(Boolean),
    totalChecks,
    passedChecks: Math.max(0, totalChecks - divergences.length),
    divergences,
    binding,
  };
}

function compareField(
  f: BenchmarkExpectation['fields'][number],
  o: FieldObservation,
  out: SemanticDivergence[],
): void {
  const key = f.fieldKey;
  const contract = getSemanticContract(key);

  // ---------- 枚举域 ----------
  if (contract.enumDomain && o.observedValue !== null && o.observedValue !== undefined) {
    if (!contract.enumDomain.includes(String(o.observedValue))) {
      out.push(
        divergence(
          'enum',
          o.defectId,
          key,
          'major',
          `枚举域 ${contract.enumDomain.join('|')} 之一或 null`,
          String(o.observedValue),
          '消费方输出了枚举域外的值（常见于把 null 映射成自造默认值）。',
          '未记录时保留 null，不得臆造默认枚举。',
        ),
      );
      return;
    }
  }

  // ---------- 空值不变量 ----------
  if (f.expectedValue === null) {
    if (o.observedValue !== null && o.observedValue !== undefined && o.observedValue !== '') {
      out.push(
        divergence(
          'null',
          o.defectId,
          key,
          'blocker',
          'null（保留业务空值含义）',
          String(o.observedValue),
          `字段 ${key} 的语义空值被消费方替换成具体值，null 含义（未测量/未采集/未填报/未核验）被破坏。`,
          '空值必须透传为 null 并展示契约空值文案，禁止补 0、空串、纪元时间或默认枚举。',
        ),
      );
      return;
    }
  }

  // ---------- 检出限（<LOD 是独立语义，不是 0 也不是 null） ----------
  if (f.expectedValue === '<LOD>') {
    if (o.observedValue === '<LOD>') {
      // 值域正确，继续核对展示文本
    } else if (typeof o.observedValue === 'number' && approxEqual(o.observedValue, 0)) {
      out.push(
        divergence(
          'rounding',
          o.defectId,
          key,
          'blocker',
          '<0.1 mm（低于检出限，先判检出限再舍入）',
          `${o.observedValue} ${o.observedUnit ?? ''}`,
          '亚检出限读数被消费方先舍入成 0，检出限语义丢失。',
          '处理顺序改为：先与 detectionLimit 比较，低于检出限即输出 <LOD，绝不进入 toFixed。',
        ),
      );
      return;
    } else if (o.observedValue === null) {
      out.push(
        divergence(
          'null',
          o.defectId,
          key,
          'blocker',
          '<0.1 mm（低于检出限 ≠ 未测量）',
          'null',
          '消费方把“低于检出限”误判成“未测量”，两种语义被合并。',
          '区分仪器有读数但低于检出限（<LOD）与根本未测量（null）。',
        ),
      );
      return;
    } else {
      out.push(
        divergence(
          'rounding',
          o.defectId,
          key,
          'blocker',
          '<LOD>',
          String(o.observedValue),
          '检出限语义未按契约表达。',
          '低于检出限统一输出 <LOD 标记。',
        ),
      );
      return;
    }
  }

  // ---------- 数值：单位换算 + 舍入不变量 ----------
  if (typeof f.expectedValue === 'number') {
    const canonical = observedCanonicalNumber(key, o);
    if (canonical === null) {
      out.push(
        divergence(
          'unit',
          o.defectId,
          key,
          'blocker',
          `${f.expectedValue} ${contract.canonicalUnit ?? ''}`,
          String(o.observedValue),
          '预期数值字段被消费方以非数值类型输出，无法参与单位换算。',
          '数值字段保持数值类型并声明接收单位。',
        ),
      );
      return;
    }
    if (!approxEqual(canonical, f.expectedValue, 0.011)) {
      const kind: InvariantKind =
        o.receivedUnit && o.receivedUnit !== contract.canonicalUnit ? 'unit' : 'rounding';
      out.push(
        divergence(
          kind,
          o.defectId,
          key,
          'blocker',
          `${f.expectedValue} ${contract.canonicalUnit ?? ''}`,
          `${o.observedValue} ${o.receivedUnit ?? contract.canonicalUnit}（折算 ${canonical}）`,
          kind === 'unit'
            ? `消费方以 ${o.receivedUnit} 接收但未按契约因子换算回 ${contract.canonicalUnit}，单位语义错误。`
            : `消费方舍入结果与契约 scale=${contract.scale ?? '?'} 不一致。`,
          kind === 'unit'
            ? `按声明因子换算：基准值 = 接收值 × 因子（见语义契约 ${key}.unitConversions）。`
            : '使用定点四舍五入并先判检出限。',
        ),
      );
      return;
    }
  }

  // ---------- 坐标（对象值） ----------
  if (
    f.expectedValue &&
    typeof f.expectedValue === 'object' &&
    'x' in (f.expectedValue as Record<string, unknown>)
  ) {
    const ev = f.expectedValue as { x: string; y: string };
    const ov = o.observedValue as { x: string; y: string } | null | undefined;
    if (!ov || typeof ov !== 'object' || ov.x !== ev.x || ov.y !== ev.y) {
      out.push(
        divergence(
          'rounding',
          o.defectId,
          key,
          'blocker',
          `(${ev.x}, ${ev.y}) m`,
          String(ov),
          '坐标交付精度（0.1 m 定点舍入）与契约不一致。',
          'x/y 分别按契约 scale 定点舍入。',
        ),
      );
      return;
    }
  }

  // ---------- 字符串 / 枚举非空值 ----------
  if (
    typeof f.expectedValue === 'string' &&
    f.expectedValue !== '<LOD>' &&
    String(o.observedValue) !== f.expectedValue
  ) {
    out.push(
      divergence(
        contract.enumDomain ? 'enum' : 'null',
        o.defectId,
        key,
        'major',
        f.expectedValue,
        String(o.observedValue),
        '字符串/枚举值与契约预期不一致。',
        '按枚举域原样输出代码值，展示层再映射中文标签。',
      ),
    );
    return;
  }

  // ---------- 值正确但展示文本不符（minor） ----------
  if (o.observedDisplay && o.observedDisplay !== f.expectedDisplay) {
    out.push(
      divergence(
        'null',
        o.defectId,
        key,
        'minor',
        f.expectedDisplay,
        o.observedDisplay,
        '机器值正确但展示文案与契约口径不一致，可能误导人工判读。',
        '空值/检出限/单位展示采用契约统一文案。',
      ),
    );
  }

  // ---------- 原因码（消费方自报时才核对，缺失记 minor） ----------
  if (o.reasonCodes && f.expectedReasonCodes?.length) {
    const missing = f.expectedReasonCodes.filter((c) => !o.reasonCodes!.includes(c));
    if (missing.length) {
      out.push(
        divergence(
          'filter',
          o.defectId,
          key,
          'minor',
          `原因码包含 ${f.expectedReasonCodes.join(',')}`,
          `实际 ${o.reasonCodes.join(',') || '无'}`,
          '处理结果虽对，但缺少可追溯的语义处理原因码。',
          '在投影决策中登记 below_detection_limit / null_meaning_preserved 等原因码。',
        ),
      );
    }
  }
}

/** 判定一组探针报告是否存在阻塞级语义分歧（门禁使用） */
export function hasBlocker(reports: ProbeReport[]): boolean {
  return reports.some((r) => r.divergences.some((d) => d.severity === 'blocker'));
}

export function bindingBroken(reports: ProbeReport[]): boolean {
  return reports.some((r) => Object.values(r.binding).some((v) => !v));
}
