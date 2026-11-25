import type {
  ProbeReport,
  SemanticGateCheck,
  SemanticGateReport,
  SemanticBenchmark,
} from '../../types';
import { CONTRACT_VERSION } from '../../types';
import { uid } from '../hash';
import { verifyBenchmarkHash } from './benchmark';
import { computePolicyFingerprint } from './contract';
import { differentialReplay } from './replay';
import { runMetamorphicSuite } from './metamorphic';
import { hasBlocker } from './diff';
import type { ConsumerProfile } from './probe';

// ============================================================
// 语义交付门禁（Semantic Delivery Gate）
// 结构签名（JSON 字段名/类型）相同并不代表语义一致：本门禁在“释放交付”
// 之前强制三类证据同时成立：
//   1) 冻结绑定：样本版本 / 样本哈希 / 契约版本 / 策略指纹全部匹配；
//   2) 探针比对：差分回放无 blocker 级语义分歧（单位/空值/检出限/枚举/过滤/聚合）；
//   3) 变形不变量：单位缩放、等价重排、缺失注入三组变形全部通过。
// 任一不成立 → verdict=delivery_hold（暂停交付），并给出可定位的原因清单。
// ============================================================

export interface GateRunArgs {
  benchmark: SemanticBenchmark;
  consumers: ConsumerProfile[];
  atIso: string;
}

export async function runSemanticGate(args: GateRunArgs): Promise<SemanticGateReport> {
  const { benchmark, consumers, atIso } = args;
  const currentPolicyFingerprint = await computePolicyFingerprint();

  // ---------- 检查 1：冻结绑定 ----------
  const hashIntact = verifyBenchmarkHash(benchmark);
  const contractMatch = benchmark.contractVersion === CONTRACT_VERSION;
  const policyMatch = currentPolicyFingerprint === benchmark.policyFingerprint;
  const bindingPass = hashIntact && contractMatch && policyMatch;

  // ---------- 检查 2：逐消费方差分回放 + 探针解释 ----------
  const probeReports: ProbeReport[] = [];
  const replays = consumers.map((c) =>
    differentialReplay({ benchmark, consumer: c, atIso, currentPolicyFingerprint }),
  );
  for (const r of replays) probeReports.push(r.probeReport);

  // ---------- 检查 3：逐消费方变形测试（取最严格结论） ----------
  const metamorphicReports = consumers.map((c) => runMetamorphicSuite({ benchmark, profile: c, atIso }));
  const metamorphic =
    metamorphicReports.find((r) => !r.passed) ??
    metamorphicReports[0] ??
    {
      suiteId: uid('MMS'),
      benchmarkVersion: benchmark.benchmarkVersion,
      contractVersion: benchmark.contractVersion,
      ranAt: atIso,
      cases: [],
      passed: true,
    };

  // ---------- 汇总分歧 ----------
  const allDivergences = probeReports.flatMap((r) => r.divergences);
  const unitDivergences = allDivergences.filter((d) => d.kind === 'unit');
  const nullDivergences = allDivergences.filter((d) => d.kind === 'null');
  const blockerPresent = hasBlocker(probeReports);
  const bindingBroken = probeReports.some((r) => Object.values(r.binding).some((v) => !v)) || !bindingPass;

  const checks: SemanticGateCheck[] = [
    {
      id: 'binding',
      label: '冻结绑定（样本版本 × 样本哈希 × 契约版本 × 策略指纹）',
      status: bindingPass ? 'pass' : 'fail',
      detail: bindingPass
        ? `样本 ${benchmark.benchmarkVersion}（${benchmark.benchmarkHash.slice(0, 16)}…）与契约 ${benchmark.contractVersion}、策略指纹冻结绑定一致。`
        : [
            hashIntact ? null : '基准样本集内容哈希不匹配（样本被改动或版本漂移）',
            contractMatch ? null : `契约版本漂移：样本绑定 ${benchmark.contractVersion}`,
            policyMatch ? null : '字段策略指纹漂移：契约注册表已变更，样本集必须重新冻结',
          ]
            .filter(Boolean)
            .join('；'),
    },
    {
      id: 'probe',
      label: '观测探针 × 投影预期（差分回放）',
      status: blockerPresent ? 'fail' : allDivergences.length ? 'warn' : 'pass',
      detail: blockerPresent
        ? `差分回放发现 ${allDivergences.filter((d) => d.severity === 'blocker').length} 个阻塞级语义分歧，消费语义不符合契约。`
        : allDivergences.length
          ? `无阻塞分歧，存在 ${allDivergences.length} 个提示级分歧。`
          : `${consumers.length} 个消费方对同一版本样本的探针结果与投影预期完全一致。`,
    },
    {
      id: 'metamorphic',
      label: '变形测试（单位缩放 / 等价重排 / 缺失注入）',
      status: metamorphic.passed ? 'pass' : 'fail',
      detail: metamorphic.passed
        ? `全部 ${metamorphic.cases.length} 组变形不变量成立。`
        : `${metamorphic.cases.filter((c) => !c.passed).length} 组变形不变量被违反。`,
    },
    {
      id: 'unit-invariant',
      label: '单位换算不变量专项',
      status: unitDivergences.some((d) => d.severity === 'blocker') ? 'fail' : unitDivergences.length ? 'warn' : 'pass',
      detail: unitDivergences.length
        ? `发现 ${unitDivergences.length} 处单位语义分歧（如数字未换算只换单位标签）。`
        : '所有数值字段折算回契约基准单位后与预期一致。',
    },
    {
      id: 'null-invariant',
      label: '空值 / 检出限语义专项',
      status: nullDivergences.some((d) => d.severity === 'blocker') ? 'fail' : nullDivergences.length ? 'warn' : 'pass',
      detail: nullDivergences.length
        ? `发现 ${nullDivergences.length} 处空值语义分歧（null 被替换为 0/默认枚举/纪元时间等）。`
        : 'null 与 <检出限 语义在所有消费方均被保留。',
    },
  ];

  const holdReasons: string[] = [];
  if (!bindingPass) holdReasons.push('冻结绑定失效：样本版本与字段策略未保持冻结绑定，禁止据此给出语义通过结论。');
  if (blockerPresent) {
    for (const d of allDivergences.filter((x) => x.severity === 'blocker')) {
      holdReasons.push(`[${d.kind}] ${d.defectId}.${d.fieldKey}：${d.explanation}`);
    }
  }
  if (!metamorphic.passed) {
    for (const c of metamorphic.cases.filter((x) => !x.passed)) {
      holdReasons.push(`[变形:${c.transform}] ${c.title}：${c.detail}`);
    }
  }

  return {
    reportId: uid('SGR'),
    ranAt: atIso,
    benchmarkVersion: benchmark.benchmarkVersion,
    benchmarkHash: benchmark.benchmarkHash,
    contractVersion: benchmark.contractVersion,
    policyFingerprint: currentPolicyFingerprint,
    verdict: holdReasons.length ? 'delivery_hold' : 'pass',
    holdReasons,
    checks,
    probeReports,
    metamorphic,
    replay: replays[0],
  };
}
