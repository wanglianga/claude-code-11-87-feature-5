import { useEffect, useMemo, useState } from 'react';
import type {
  InvariantKind,
  ProbeReport,
  SemanticBenchmark,
  SemanticGateReport,
} from '../types';
import { useStore } from '../state/store';
import { SEMANTIC_FIELD_CONTRACTS } from '../domain/semantic/contract';
import { buildSemanticBenchmark } from '../domain/semantic/benchmark';
import { SIMULATED_CONSUMERS } from '../domain/semantic/consumers';
import { suiteSummary } from '../domain/semantic/metamorphic';
import { Badge, Btn, Card, Empty, Hash, Stat } from './ui';

// ============================================================
// 语义验证工作台
// 结构签名相同 ≠ 语义一致。本页把五件事做成可运行机制：
// 语义行为契约 → 冻结基准样本 → 观测探针 → 差分回放/变形测试 → 交付门禁。
// ============================================================

const INVARIANT_LABELS: Record<InvariantKind, string> = {
  unit: '单位换算',
  null: '空值',
  rounding: '舍入/检出限',
  filter: '过滤',
  aggregation: '聚合',
  enum: '枚举',
};

const KIND_TONE: Record<InvariantKind, 'brand' | 'danger' | 'warn' | 'purple' | 'teal' | 'ok'> = {
  unit: 'brand',
  null: 'danger',
  rounding: 'warn',
  filter: 'purple',
  aggregation: 'teal',
  enum: 'ok',
};

export default function SemanticGate() {
  const s = useStore();
  const [benchmark, setBenchmark] = useState<SemanticBenchmark | null>(null);
  const [selected, setSelected] = useState<string[]>(SIMULATED_CONSUMERS.map((c) => c.id));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void buildSemanticBenchmark().then((b) => {
      if (!cancelled) setBenchmark(b);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const gate: SemanticGateReport | null = s.semanticGate;

  async function runGate() {
    setBusy(true);
    try {
      await s.runSemanticGate(selected);
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  return (
    <div>
      <div className="page-head">
        <h2>语义行为契约与交付门禁</h2>
        <p className="lede">
          消费方的 JSON 结构签名可以与投影完全相同，却仍把毫米当米、把 null 当 0、把未填报当成“未整改”。
          本工作台用<b>冻结基准样本</b>收集消费方探针结果，通过<b>差分回放</b>（参考实现 vs 消费方处理同一版本样本）
          与<b>变形测试</b>（单位缩放 / 等价重排 / 缺失注入）验证五类不变量；
          一旦出现阻塞级语义分歧，交付门禁判定 <b>delivery_hold（暂停交付）</b>，释放闸门同步拦截。
        </p>
      </div>

      <ContractInvariants />
      {benchmark && <BenchmarkCard benchmark={benchmark} />}
      <ConsumerPicker selected={selected} onToggle={toggle} onRun={runGate} busy={busy} />
      {gate && <GateVerdictPanel gate={gate} />}
      {gate && <ProbeReportsCard gate={gate} />}
      {gate?.replay && <ReplayCard gate={gate} />}
      {gate && <MetamorphicCard gate={gate} />}
      {!gate && (
        <Card title="尚未运行语义门禁" sub="选择消费方后点击上方按钮；门禁报告会持久化，并直接决定签名交付包能否释放。">
          <Empty>运行后在此展示冻结绑定、探针比对、差分回放、变形测试与暂停交付原因。</Empty>
        </Card>
      )}
    </div>
  );
}

// ---------------- 语义行为契约 ----------------

function ContractInvariants() {
  return (
    <Card
      title="语义行为契约（机器可执行的不变量声明）"
      sub="在字段契约的类型/单位/精度描述之上，声明消费方必须遵守的单位换算因子、空值纪律、舍入顺序、枚举域、过滤与聚合不变量。"
    >
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>字段</th>
              <th>基准单位 / 换算因子</th>
              <th>空值纪律 · 检出限 · 枚举域</th>
              <th>不变量声明</th>
            </tr>
          </thead>
          <tbody>
            {SEMANTIC_FIELD_CONTRACTS.map((c) => (
              <tr key={c.fieldKey}>
                <td style={{ minWidth: 130 }}>
                  <div style={{ fontWeight: 700 }}>{c.label}</div>
                  <div className="contract-key">{c.fieldKey}</div>
                </td>
                <td className="small" style={{ minWidth: 190 }}>
                  {c.canonicalUnit ? (
                    <>
                      <div>
                        基准单位：<b>{c.canonicalUnit}</b>
                      </div>
                      <div className="mono tiny mt8">
                        {(c.unitConversions ?? [])
                          .filter((u) => u.unit !== c.canonicalUnit)
                          .map((u) => `1 ${u.unit} = ${u.factor} ${c.canonicalUnit}`)
                          .join('　')}
                      </div>
                    </>
                  ) : (
                    <span className="muted">无单位</span>
                  )}
                  {c.scale !== undefined && <div className="tiny mt8">舍入 scale={c.scale}</div>}
                </td>
                <td className="small" style={{ minWidth: 200 }}>
                  <div>空值：{c.nullPolicy === 'preserve_null' ? '必须保留 null 语义' : '不适用'}</div>
                  {c.detectionLimit !== undefined && (
                    <div className="tone-purple tiny mt8">检出限 {c.detectionLimit} {c.canonicalUnit}（先判检出限再舍入）</div>
                  )}
                  {c.enumDomain && (
                    <div className="mono tiny mt8">{c.enumDomain.join(' | ')}</div>
                  )}
                  {c.aggregationRule && <div className="tiny mt8 tone-teal">{c.aggregationRule}</div>}
                </td>
                <td style={{ minWidth: 320 }}>
                  <div className="flex gap6 wrap">
                    {c.invariantStatements.map((st, i) => (
                      <Badge key={i} tone={KIND_TONE[st.kind]} title={st.statement}>
                        {INVARIANT_LABELS[st.kind]}
                      </Badge>
                    ))}
                  </div>
                  <ul className="small mt8" style={{ paddingLeft: 18, margin: 0 }}>
                    {c.invariantStatements.map((st, i) => (
                      <li key={i} className="mb8">{st.statement}</li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------- 冻结基准样本 ----------------

function BenchmarkCard({ benchmark }: { benchmark: SemanticBenchmark }) {
  return (
    <Card
      title="受控基准输入集（版本冻结绑定）"
      sub="样本刻意覆盖常规舍入、舍入边界、低于检出限、测量/坐标/枚举/时间缺失与跨标段过滤；样本内容哈希与契约版本、字段策略指纹冻结绑定。"
      extra={
        <div className="flex gap8 wrap">
          <Badge tone="brand">{benchmark.benchmarkVersion}</Badge>
          <Badge tone="slate">契约 {benchmark.contractVersion}</Badge>
        </div>
      }
    >
      <div className="stat-grid">
        <Stat label="样本版本" value={benchmark.benchmarkVersion} tone="brand" />
        <Stat label="样本数" value={benchmark.defects.length} />
        <Stat label="可见样本（参考画像 B1）" value={benchmark.expectations.filter((e) => e.visible).length} tone="ok" />
        <Stat label="被过滤样本" value={benchmark.expectations.filter((e) => !e.visible).length} tone="purple" />
      </div>
      <div className="small mb12">
        样本集哈希：<Hash value={benchmark.benchmarkHash} head={22} tail={12} />
        <span className="muted">（任一样本字节变化都会改变哈希，旧探针绑定随即失效）</span>
      </div>
      <div className="small mb12">
        策略指纹：<Hash value={benchmark.policyFingerprint} head={22} tail={12} />
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>样本</th>
              <th>标段/可见性</th>
              <th>裂缝宽度（源 → 预期）</th>
              <th>坐标 / 空值边界</th>
              <th>语义标签</th>
            </tr>
          </thead>
          <tbody>
            {benchmark.defects.map((d) => {
              const exp = benchmark.expectations.find((e) => e.defectId === d.defectId)!;
              const widthExp = exp.fields.find((f) => f.fieldKey === 'crackWidthMm')!;
              const coordExp = exp.fields.find((f) => f.fieldKey === 'coordinate')!;
              return (
                <tr key={d.defectId}>
                  <td className="mono">{d.defectId}</td>
                  <td>
                    <span className="mono tiny">{d.sectionId}</span>
                    <div className="mt8">
                      {exp.visible ? <Badge tone="ok">可见</Badge> : <Badge tone="purple">必须过滤</Badge>}
                    </div>
                  </td>
                  <td className="small">
                    <div>
                      源：<b>{d.crackWidthMm === null ? 'null' : `${d.crackWidthMm} mm`}</b>
                    </div>
                    <div className="mt8 tone-brand">
                      预期：{String(widthExp.expectedValue)} · {widthExp.expectedDisplay}
                    </div>
                  </td>
                  <td className="small">
                    <div>坐标：{d.coordinate ? `(${d.coordinate.x}, ${d.coordinate.y})` : 'null'}</div>
                    <div className="tiny muted mt8">{coordExp.expectedDisplay}</div>
                  </td>
                  <td>
                    <div className="flex gap6 wrap">
                      {d.semanticTags.map((t) => (
                        <Badge key={t} tone="slate">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------- 消费方选择与门禁运行 ----------------

function ConsumerPicker({
  selected,
  onToggle,
  onRun,
  busy,
}: {
  selected: string[];
  onToggle: (id: string) => void;
  onRun: () => void;
  busy: boolean;
}) {
  return (
    <Card
      title="差分回放对象（模拟消费方）"
      sub="所有消费方读取完全相同的 JSON 结构，差异只在语义解释。选择后对同一版本冻结样本运行参考实现 vs 消费方差分回放、探针解释与变形测试。"
      extra={
        <Btn variant="primary" onClick={onRun} disabled={busy || selected.length === 0}>
          {busy ? <><span className="spin" /> 门禁运行中…</> : '🛂 运行语义交付门禁'}
        </Btn>
      }
    >
      <div className="pkg-grid">
        {SIMULATED_CONSUMERS.map((c) => {
          const on = selected.includes(c.id);
          return (
            <label key={c.id} className="pkg-card" style={{ cursor: 'pointer', outline: on ? '2px solid var(--brand)' : undefined }}>
              <div className="flex gap8 wrap mb8">
                <input type="checkbox" checked={on} onChange={() => onToggle(c.id)} />
                <span className="pkg-id">{c.id}</span>
              </div>
              <div style={{ fontWeight: 700 }}>{c.name}</div>
              <p className="small mt8" style={{ margin: 0 }}>{c.description}</p>
            </label>
          );
        })}
      </div>
    </Card>
  );
}

// ---------------- 门禁结论 ----------------

function GateVerdictPanel({ gate }: { gate: SemanticGateReport }) {
  const hold = gate.verdict === 'delivery_hold';
  return (
    <Card
      title="交付门禁结论"
      sub="结构签名相同但输出违反单位/空值等不变量时，结论为暂停交付；该状态持久化并在“签名交付包”释放时强制拦截。"
      extra={
        <Badge tone={hold ? 'danger' : 'ok'} style={{ fontSize: 14, padding: '8px 16px' }}>
          {hold ? '⛔ DELIVERY_HOLD · 暂停交付' : '✅ PASS · 语义可交付'}
        </Badge>
      }
    >
      <div className="stat-grid">
        <Stat label="门禁报告" value={<span className="mono tiny">{gate.reportId}</span>} />
        <Stat label="探针报告数" value={gate.probeReports.length} />
        <Stat
          label="阻塞级分歧"
          value={gate.probeReports.reduce((n, r) => n + r.divergences.filter((d) => d.severity === 'blocker').length, 0)}
          tone={hold ? 'danger' : 'ok'}
        />
        <Stat label="变形测试" value={`${suiteSummary(gate.metamorphic).passed}/${suiteSummary(gate.metamorphic).total} 通过`} tone={gate.metamorphic.passed ? 'ok' : 'danger'} />
      </div>
      <div className="check-list">
        {gate.checks.map((c) => (
          <div key={c.id} className={`check ${c.status === 'pass' ? 'pass' : c.status === 'warn' ? 'warn' : ''}`}>
            <span className="check-icon">{c.status === 'pass' ? '✅' : c.status === 'warn' ? '⚠️' : '⛔'}</span>
            <div>
              <div className="check-label">
                {c.label} <Badge tone={c.status === 'pass' ? 'ok' : c.status === 'warn' ? 'warn' : 'danger'}>{c.status}</Badge>
              </div>
              <div className="check-detail">{c.detail}</div>
            </div>
          </div>
        ))}
      </div>
      {hold && (
        <div className="step-msg err mt16">
          <b>暂停交付原因（{gate.holdReasons.length}）：</b>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {gate.holdReasons.map((r, i) => (
              <li key={i} className="mb8">{r}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

// ---------------- 探针报告与差异解释 ----------------

function ProbeReportsCard({ gate }: { gate: SemanticGateReport }) {
  return (
    <Card title="观测探针 × 投影预期：差异解释" sub="差异解释器把分歧定位到 实体 × 字段 × 不变量，并给出预期值、观测值与修复指引。">
      {gate.probeReports.map((r) => (
        <ProbeReportTable key={r.probeId} report={r} />
      ))}
    </Card>
  );
}

function ProbeReportTable({ report }: { report: ProbeReport }) {
  const blockers = report.divergences.filter((d) => d.severity === 'blocker').length;
  return (
    <div className="pkg-card mb16">
      <div className="flex gap8 wrap mb8">
        <span className="pkg-id">{report.consumerId}</span>
        <Badge tone={report.matched ? 'ok' : blockers ? 'danger' : 'warn'}>
          {report.matched ? '完全一致' : `${blockers} 阻塞 / ${report.divergences.length} 总分歧`}
        </Badge>
        <Badge tone={Object.values(report.binding).every(Boolean) ? 'ok' : 'danger'}>
          冻结绑定 {Object.values(report.binding).every(Boolean) ? '一致' : '漂移'}
        </Badge>
        <span className="muted tiny">
          检查 {report.passedChecks}/{report.totalChecks} 通过
        </span>
      </div>
      <div className="flex gap6 wrap mb12 tiny">
        <span>绑定：</span>
        <Badge tone={report.binding.benchmarkVersionMatch ? 'ok' : 'danger'}>样本版本</Badge>
        <Badge tone={report.binding.benchmarkHashMatch ? 'ok' : 'danger'}>样本哈希</Badge>
        <Badge tone={report.binding.contractVersionMatch ? 'ok' : 'danger'}>契约版本</Badge>
        <Badge tone={report.binding.policyFingerprintMatch ? 'ok' : 'danger'}>策略指纹</Badge>
      </div>
      {report.divergences.length === 0 ? (
        <Empty>探针结果与投影预期逐项一致，无语义分歧。</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>不变量</th>
                <th>位置</th>
                <th>严重度</th>
                <th>预期 / 观测</th>
                <th>解释与修复指引</th>
              </tr>
            </thead>
            <tbody>
              {report.divergences.map((d) => (
                <tr key={d.divergenceId}>
                  <td><Badge tone={KIND_TONE[d.kind]}>{INVARIANT_LABELS[d.kind]}</Badge></td>
                  <td className="mono tiny">{d.defectId}.{d.fieldKey}</td>
                  <td>
                    <Badge tone={d.severity === 'blocker' ? 'danger' : d.severity === 'major' ? 'warn' : 'slate'}>{d.severity}</Badge>
                  </td>
                  <td className="small" style={{ minWidth: 220 }}>
                    <div className="tone-ok">预期：{d.expected}</div>
                    <div className="tone-danger mt8">观测：{d.observed}</div>
                  </td>
                  <td className="small" style={{ minWidth: 280 }}>
                    <div>{d.explanation}</div>
                    <div className="tone-brand tiny mt8">修复：{d.hint}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------- 差分回放侧写 ----------------

function ReplayCard({ gate }: { gate: SemanticGateReport }) {
  const replay = gate.replay!;
  const refAgg = replay.referenceProbe.aggregationSummary;
  const conAgg = replay.consumerProbe.aggregationSummary;
  return (
    <Card
      title={`差分回放侧写 · ${replay.consumerId}`}
      sub="参考实现与消费方处理同一版本样本；回放需消费方执行，平台只接收其探针并与参考侧比对。"
      extra={<Badge tone={replay.bindingValid ? 'ok' : 'danger'}>绑定{replay.bindingValid ? '有效' : '失效'}</Badge>}
    >
      <div className="grid-2">
        <div className="pkg-card">
          <div className="check-label mb8">{replay.referenceProbe.consumerName}</div>
          <div className="small">
            观测字段数：{replay.referenceProbe.observations.length}
            {refAgg && (
              <ul className="mt8" style={{ paddingLeft: 18, margin: 0 }}>
                <li>聚合计数：{refAgg.count}（null / &lt;LOD 排除）</li>
                <li>合计：{refAgg.sumMm} mm</li>
                <li>均值：{refAgg.avgMm ?? 'null'} mm</li>
                <li>按 0 误入名单：{refAgg.countedAsZero.length ? refAgg.countedAsZero.join(', ') : '无'}</li>
              </ul>
            )}
          </div>
        </div>
        <div className="pkg-card">
          <div className="check-label mb8">{replay.consumerProbe.consumerName}</div>
          <div className="small">
            观测字段数：{replay.consumerProbe.observations.length}
            {conAgg && (
              <ul className="mt8" style={{ paddingLeft: 18, margin: 0 }}>
                <li>聚合计数：{conAgg.count}</li>
                <li>合计：{conAgg.sumMm} mm</li>
                <li>均值：{conAgg.avgMm ?? 'null'} mm</li>
                <li className={conAgg.countedAsZero.length ? 'tone-danger' : ''}>
                  按 0 计入名单：{conAgg.countedAsZero.length ? conAgg.countedAsZero.join(', ') : '无'}
                </li>
              </ul>
            )}
          </div>
        </div>
      </div>
      <p className="tiny muted mt12" style={{ marginBottom: 0 }}>
        回放 {replay.replayId} · 样本 {replay.benchmarkVersion}（<Hash value={replay.benchmarkHash} head={14} tail={8} />） · 契约 {replay.contractVersion}
      </p>
    </Card>
  );
}

// ---------------- 变形测试 ----------------

function MetamorphicCard({ gate }: { gate: SemanticGateReport }) {
  const summary = useMemo(() => suiteSummary(gate.metamorphic), [gate]);
  return (
    <Card
      title="变形测试套件"
      sub="不依赖已知答案：对输入施加语义等价变换后断言不变量。接入轻，任何消费方处理器都可运行；违反时结合上方差分回放定位根因。"
      extra={
        <Badge tone={gate.metamorphic.passed ? 'ok' : 'danger'}>
          {summary.passed}/{summary.total} 通过
        </Badge>
      }
    >
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>变形</th>
              <th>用例</th>
              <th>不变量</th>
              <th>预期 / 观测</th>
              <th>结论</th>
            </tr>
          </thead>
          <tbody>
            {gate.metamorphic.cases.map((c) => (
              <tr key={c.caseId}>
                <td><Badge tone="teal">{c.transform}</Badge></td>
                <td className="small" style={{ minWidth: 200 }}>
                  <div style={{ fontWeight: 700 }}>{c.title}</div>
                  <div className="tiny muted mt8">{c.description}</div>
                </td>
                <td><Badge tone={KIND_TONE[c.invariantKind]}>{INVARIANT_LABELS[c.invariantKind]}</Badge></td>
                <td className="small" style={{ minWidth: 220 }}>
                  <div className="tone-ok">预期：{c.expected}</div>
                  <div className={c.passed ? '' : 'tone-danger'}>观测：{c.observed}</div>
                  <div className="tiny muted mt8">{c.detail}</div>
                </td>
                <td>
                  <Badge tone={c.passed ? 'ok' : 'danger'}>{c.passed ? '不变量成立' : '不变量违反'}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
