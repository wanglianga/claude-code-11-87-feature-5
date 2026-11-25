import { useMemo, useState } from 'react';
import type { DecisionOutcome, FieldDecision, Projection, ValidationReport } from '../types';
import { REASON_TEXT } from '../domain/compiler';
import { Badge, Card, Hash, toneFromStatus } from './ui';

// ---------------- 六维授权轨迹 ----------------
export function AuthTraceTable({ projection }: { projection: Projection }) {
  return (
    <div className="trace-grid">
      {projection.authTrace.map((t) => (
        <div key={t.dimension} className={`trace-item ${t.passed ? 'pass' : 'fail'}`}>
          <div className="trace-dim">
            <span>{t.label}</span>
            <span>{t.passed ? '✓ 通过' : '✗ 拒绝'}</span>
          </div>
          <div className="trace-vals">
            <div className="req">要求：{t.required}</div>
            <div className="granted">许可：{t.granted}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------- 字段级决策表 ----------------
type Filter = 'all' | DecisionOutcome;

export function DecisionTable({ decisions, maxHeight }: { decisions: FieldDecision[]; maxHeight?: number }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');

  const counts = useMemo(
    () => ({
      all: decisions.length,
      included: decisions.filter((d) => d.outcome === 'included').length,
      transformed: decisions.filter((d) => d.outcome === 'transformed').length,
      excluded: decisions.filter((d) => d.outcome === 'excluded').length,
    }),
    [decisions],
  );

  const rows = decisions.filter((d) => {
    if (filter !== 'all' && d.outcome !== filter) return false;
    if (q && !`${d.entityId} ${d.fieldLabel} ${d.fieldKey}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  const filters: { key: Filter; label: string }[] = [
    { key: 'all', label: `全部 ${counts.all}` },
    { key: 'included', label: `可见 ${counts.included}` },
    { key: 'transformed', label: `契约化处理 ${counts.transformed}` },
    { key: 'excluded', label: `已过滤 ${counts.excluded}` },
  ];

  return (
    <div>
      <div className="flex gap8 wrap mb12">
        {filters.map((f) => (
          <button
            key={f.key}
            className={`btn btn-sm ${filter === f.key ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
        <input
          className="input"
          style={{ width: 220, padding: '5px 10px' }}
          placeholder="搜索实体 / 字段…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="table-wrap" style={maxHeight ? { maxHeight, overflow: 'auto' } : undefined}>
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: 90 }}>结果</th>
              <th style={{ width: 110 }}>实体</th>
              <th>字段</th>
              <th>过滤 / 处理原因（授权交集逐维记录）</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.uid}>
                <td>
                  <span className={`outcome-pill outcome-${d.outcome}`}>
                    {d.outcome === 'included' ? '输出' : d.outcome === 'transformed' ? '精度/语义处理' : '过滤'}
                  </span>
                </td>
                <td>
                  <span className="mono tiny">{d.entityId}</span>
                </td>
                <td>
                  <div style={{ fontWeight: 650 }}>{d.fieldLabel}</div>
                  <div className="muted tiny mono">{d.fieldKey}</div>
                </td>
                <td>
                  <div className="reason-chips">
                    {d.reasons.map((r, i) => (
                      <span
                        key={i}
                        className={`reason ${
                          r.code === 'included'
                            ? 'good'
                            : ['rounded_to_contract_scale', 'coordinate_precision_applied', 'below_detection_limit', 'null_meaning_preserved', 'source_revision_pinned'].includes(r.code)
                              ? 'info'
                              : r.code.endsWith('_denied') || r.code.includes('not_') || r.code.includes('unauthorized')
                                ? 'bad'
                                : ''
                        }`}
                        title={REASON_TEXT[r.code]}
                      >
                        {r.message}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4}>
                  <div className="empty">没有匹配的字段决策。</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------- 缺陷投影卡片 ----------------
export function DefectProjectionCards({ projection }: { projection: Projection }) {
  if (projection.defects.length === 0) {
    return <div className="empty">当前授权交集下没有任何可输出的缺陷记录（标段/字段组/项目维度被过滤）。</div>;
  }
  return (
    <div className="defect-grid">
      {projection.defects.map((d) => (
        <div className="defect-card" key={d.defectId}>
          <div className="flex gap8 mb8">
            <span className="defect-id">{d.defectId}</span>
            {d.sectionId && <Badge tone="brand">{String(d.sectionId.value)} 标段</Badge>}
          </div>
          {d.coordinate && (
            <div className="field-line">
              <span className="field-label">现场坐标</span>
              <span className="field-value mono">{d.coordinate.display}</span>
            </div>
          )}
          {d.crackWidth && (
            <div className="field-line">
              <span className="field-label">裂缝宽度</span>
              <span
                className={`field-value ${d.crackWidth.belowDetectionLimit ? 'value-lod' : ''}`}
                style={{ fontWeight: 700, fontSize: 15 }}
              >
                {d.crackWidth.display}
                {d.crackWidth.belowDetectionLimit && <Badge tone="purple">低于检出限</Badge>}
              </span>
            </div>
          )}
          {d.detectionMethod && (
            <div className="field-line">
              <span className="field-label">检测方法</span>
              <span className="field-value">{d.detectionMethod.display}</span>
            </div>
          )}
          {d.rectificationStatus && (
            <div className="field-line">
              <span className="field-label">整改状态</span>
              <span className="field-value">{d.rectificationStatus.display}</span>
            </div>
          )}
          {d.verifiedAt && (
            <div className="field-line">
              <span className="field-label">核验时间</span>
              <span className={`field-value ${d.verifiedAt.value === '' ? 'value-null' : ''}`}>{d.verifiedAt.display}</span>
            </div>
          )}
          {d.imageSummary && (
            <div className="field-line">
              <span className="field-label">影像摘要</span>
              <span className="field-value">{d.imageSummary.display}</span>
            </div>
          )}
          {d.attachments && (
            <div className="field-line">
              <span className="field-label">影像附件</span>
              <span className="field-value">
                {d.attachments.value.length === 0 ? (
                  <span className="muted">无授权可见引用</span>
                ) : (
                  d.attachments.value.map((a) => (
                    <div key={a.attachmentId} className="tiny" style={{ marginBottom: 3 }}>
                      📎 {a.filename} <Hash value={a.sha256} head={8} tail={6} />
                    </div>
                  ))
                )}
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------- 附件索引 ----------------
export function AttachmentIndexTable({ projection }: { projection: Projection }) {
  if (projection.attachmentIndex.length === 0) return null;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>附件ID</th>
            <th>文件名</th>
            <th>类型</th>
            <th>SHA-256</th>
            <th>大小</th>
          </tr>
        </thead>
        <tbody>
          {projection.attachmentIndex.map((a) => (
            <tr key={a.attachmentId}>
              <td className="mono">{a.attachmentId}</td>
              <td>{a.filename}</td>
              <td>
                <Badge tone="teal">{a.kind}</Badge>
              </td>
              <td>
                <Hash value={a.sha256} />
              </td>
              <td className="mono tiny">{a.bytes} B</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------- 审计保证块 ----------------
export function AssurancePanel({ projection }: { projection: Projection }) {
  if (!projection.assurance) {
    return <div className="empty">当前角色/用途/字段组交集不包含 assurance（签名与修订链）。</div>;
  }
  const a = projection.assurance;
  return (
    <div>
      <dl className="kv mb12">
        <dt>报告哈希</dt>
        <dd>
          <Hash value={a.reportHash} head={20} tail={12} />
        </dd>
        <dt>数字签名</dt>
        <dd>
          <Hash value={a.signature} head={24} tail={16} />
        </dd>
        <dt>签署方</dt>
        <dd>{a.signedBy}</dd>
        <dt>签署时间</dt>
        <dd>{a.signedAt}</dd>
      </dl>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>修订</th>
              <th>报告哈希</th>
              <th>签署时间</th>
              <th>变更说明</th>
            </tr>
          </thead>
          <tbody>
            {a.revisionChain.map((c) => (
              <tr key={c.revision}>
                <td>
                  <Badge tone={c.revision === projection.revision ? 'ok' : 'purple'}>R1 r{c.revision}</Badge>
                </td>
                <td>
                  <Hash value={c.reportHash} />
                </td>
                <td className="tiny">{c.signedAt}</td>
                <td className="small">{c.changeNote}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------- 校验报告 ----------------
export function ValidationPanel({ validation }: { validation: ValidationReport }) {
  return (
    <div>
      <div className={`banner ${validation.valid ? 'banner-ok' : 'banner-danger'}`}>
        <span className="bi">{validation.valid ? '✅' : '⛔'}</span>
        <div>
          <b>{validation.valid ? '包校验通过' : '包校验未通过'}</b>
          <div className="tiny muted">校验时间 {validation.validatedAt}</div>
        </div>
      </div>
      <div className="check-list">
        {validation.checks.map((c) => (
          <div key={c.id} className={`check ${c.status}`}>
            <span className="check-icon">{c.status === 'pass' ? '✓' : c.status === 'fail' ? '✕' : '!'}</span>
            <div>
              <div className="check-label">
                {c.label} <Badge tone={toneFromStatus(c.status)}>{c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : 'SKIP'}</Badge>
              </div>
              <div className="check-detail">{c.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------- 完整投影视图 ----------------
export function ProjectionView({
  projection,
  validation,
  workerMs,
}: {
  projection: Projection;
  validation?: ValidationReport | null;
  workerMs?: number;
}) {
  return (
    <div>
      {projection.deniedReason && (
        <div className="banner banner-danger">
          <span className="bi">⛔</span>
          <div>
            <b>投影被整体拒绝：{projection.deniedReason.message}</b>
            <div className="small">编译器仍保留全部实体的字段级过滤原因，见下方决策表。</div>
          </div>
        </div>
      )}

      <div className="flex gap8 wrap mb12">
        <Badge tone="brand">模式：{projection.mode === 'dynamic' ? '动态实时投影' : '固定物化投影'}</Badge>
        <Badge tone="slate">
          {projection.reportNo} · r{projection.revision}
        </Badge>
        {projection.licenseSnapshot && (
          <Badge tone="teal">
            固定许可 {projection.licenseSnapshot.licenseId} · v{projection.licenseSnapshot.licenseVersion}
          </Badge>
        )}
        <Badge tone="slate">契约 {projection.contractVersion}</Badge>
        {typeof workerMs === 'number' && <Badge tone="purple">WebWorker 耗时 {workerMs} ms</Badge>}
      </div>

      <Card title="授权六维交集轨迹" sub="以报告号锚点字段求值；标段维度在每条缺陷/附件决策中再次逐条求值。">
        <AuthTraceTable projection={projection} />
      </Card>

      <Card title={`缺陷投影（${projection.defects.length} 条）`} sub="精度、单位、检出限与空值语义均按字段契约输出。">
        <DefectProjectionCards projection={projection} />
      </Card>

      {projection.attachmentIndex.length > 0 && (
        <Card title={`授权附件索引（${projection.attachmentIndex.length} 条）`} sub="仅包含通过标段与索引可见性检查的附件。">
          <AttachmentIndexTable projection={projection} />
        </Card>
      )}

      {projection.assurance && (
        <Card title="签名与修订链" sub="assurance 字段组，审计角色可见。">
          <AssurancePanel projection={projection} />
        </Card>
      )}

      {validation && (
        <Card title="包校验器实时报告" sub="必需字段 / 单位 / 签名 / 附件引用 / 报告哈希 / 授权版本">
          <ValidationPanel validation={validation} />
        </Card>
      )}

      <Card title="字段级过滤原因账本" sub="编译器对每个实体 × 每个契约字段保留输出、契约化处理或过滤的完整原因。">
        <DecisionTable decisions={projection.decisions} />
      </Card>
    </div>
  );
}
