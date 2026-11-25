import { useMemo, useState } from 'react';
import { useStore } from '../state/store';
import { hmacSha256HexSync } from '../domain/sha256';
import { DEMO_SIGNING_SECRET } from '../domain/hash';
import { getContract } from '../domain/contracts';
import type { AuditEvent, ReviewComment } from '../types';
import { Btn, Card, Badge, Hash, Empty } from './ui';

type Sub = 'chain' | 'comments' | 'audit';

const AUDIT_ICON: Record<AuditEvent['type'], string> = {
  package_materialized: '🔏',
  package_released: '📤',
  package_release_blocked: '🚫',
  package_rebuilt: '♻️',
  dynamic_projection_generated: '⚡',
  validation_failed: '🧯',
  license_revoked: '⛔',
  license_renewed: '📜',
  revision_published: '🆕',
  comments_merged: '🔀',
  receipt_registered: '🧾',
  conflict_adjudicated: '⚖️',
  offline_edit_blocked: '🔒',
  semantic_gate_hold: '🛂',
  semantic_gate_passed: '✅',
};

export default function History() {
  const [sub, setSub] = useState<Sub>('chain');
  return (
    <div>
      <div className="subtabs">
        <button className={`subtab ${sub === 'chain' ? 'active' : ''}`} onClick={() => setSub('chain')}>
          修订链与差异
        </button>
        <button className={`subtab ${sub === 'comments' ? 'active' : ''}`} onClick={() => setSub('comments')}>
          审阅意见历史
        </button>
        <button className={`subtab ${sub === 'audit' ? 'active' : ''}`} onClick={() => setSub('audit')}>
          审计账本
        </button>
      </div>
      {sub === 'chain' && <ChainTab />}
      {sub === 'comments' && <CommentsTab />}
      {sub === 'audit' && <AuditTab />}
    </div>
  );
}

function RevisionSigBadge({ reportHash, signature }: { reportHash: string; signature: string }) {
  const ok = useMemo(
    () => hmacSha256HexSync(DEMO_SIGNING_SECRET, `report-revision:${reportHash}`) === signature,
    [reportHash, signature],
  );
  return <Badge tone={ok ? 'ok' : 'danger'}>{ok ? '✓ 修订签名有效' : '✕ 签名失配'}</Badge>;
}

function ChainTab() {
  const s = useStore();
  if (!s.server) return null;
  const report = s.server.reports.R1;
  const r1 = report.revisions[0];
  const r2 = report.revisions.find((r) => r.revision === 2);

  return (
    <div>
      <div className="banner banner-info">
        <span className="bi">🕓</span>
        <div>
          报告 <b>R1</b> 的每个修订独立哈希、独立签署；发布修订2不会覆盖或删除修订1。审计员可查看整条修订链与签名，但看不到任何未授权项目（如 Q）的缺陷记录。
        </div>
      </div>

      <div className="rev-chain">
        {report.revisions.map((rev) => (
          <div key={rev.revision} className={`rev-card ${rev.revision === report.currentRevision ? 'current' : 'old'}`}>
            <div className="flex gap8 wrap">
              <span className="rev-no">修订 {rev.revision}</span>
              {rev.revision === report.currentRevision ? <Badge tone="ok">当前版本</Badge> : <Badge tone="purple">历史签署版</Badge>}
              {rev.revision === 1 && r2 && <Badge tone="warn">已被修订2更正</Badge>}
            </div>
            <h4 className="mt8" style={{ fontSize: 14 }}>{rev.title}</h4>
            <div className="small muted mt8">{rev.changeNote}</div>
            <dl className="kv mt12">
              <dt>发布时间</dt>
              <dd className="small">{rev.publishedAt}</dd>
              <dt>签署方</dt>
              <dd className="small">{rev.signedBy}</dd>
              <dt>报告哈希</dt>
              <dd><Hash value={rev.reportHash} head={22} tail={12} /></dd>
              <dt>签名</dt>
              <dd><Hash value={rev.signature} head={22} tail={12} /></dd>
            </dl>
            <div className="mt8">
              <RevisionSigBadge reportHash={rev.reportHash} signature={rev.signature} />
            </div>
          </div>
        ))}
      </div>

      {r2 && (
        <Card title="修订1 → 修订2 字段差异（触发重审的依据）" className="mt16">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>缺陷</th>
                  <th>字段</th>
                  <th>修订1（基线）</th>
                  <th></th>
                  <th>修订2（当前）</th>
                </tr>
              </thead>
              <tbody>
                {r2.changes.map((c, i) => (
                  <tr key={i}>
                    <td className="mono">{c.defectId}</td>
                    <td>{fieldLabel(c.field)}</td>
                    <td>
                      <span className="diff-old">{String(c.before)}</span>
                    </td>
                    <td className="arrow">→</td>
                    <td>
                      <span className="diff-new">{String(c.after)}</span>
                      {c.field === 'crackWidthMm' && <span className="muted small"> mm（契约显示 12.0 → 15.0）</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted mt12">
            合并离线意见时，正是依据这张变更表把关联在 r1 基线上的意见标记为「需对 r2 重审」。
          </p>
        </Card>
      )}

      <Card title="项目隔离证明" sub="审计许可仅覆盖 P；切换到「交付编译」的『审计访问 Q』预设可看到 project_not_authorized 拒绝。">
        <div className="small">
          工作区中另有项目 <b>Q（北山隧道定期检测项目）</b> 与报告 <b>RQ-1</b>，但审计员、施工方、监理许可均未覆盖 Q，因此任何投影都不会释放 Q 的缺陷或附件记录。
        </div>
      </Card>
    </div>
  );
}

function fieldLabel(key: string): string {
  try {
    return getContract(key).label;
  } catch {
    return key;
  }
}

function CommentsTab() {
  const s = useStore();
  const all = useMemo(() => {
    const map = new Map<string, ReviewComment>();
    for (const c of s.server?.serverComments ?? []) map.set(c.commentId, c);
    for (const c of s.localComments) map.set(c.commentId, c);
    return [...map.values()].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
  }, [s.server, s.localComments]);

  if (all.length === 0) return <Card><Empty>还没有审阅意见。到「离线审阅」执行场景步骤4/7。</Empty></Card>;

  return (
    <Card title={`全部审阅意见（${all.length}）`} sub="每条意见永久携带意见ID与基线修订/哈希；重审标记由修订差异计算。">
      {all.map((c) => (
        <div className="comment-card" key={c.commentId}>
          <div className="comment-head">
            <span className="comment-author">{c.authorName}</span>
            <Badge tone="brand">{c.defectId}</Badge>
            <span className="comment-time">{new Date(c.updatedAt).toLocaleString('zh-CN')}</span>
            <span className="spacer" />
            {c.syncState === 'synced' ? <Badge tone="ok">已合并</Badge> : <Badge tone="warn">{c.syncState}</Badge>}
            {c.needsReReviewFor && <Badge tone="warn">需对 r{c.needsReReviewFor} 重审</Badge>}
          </div>
          <div className="comment-body">{c.body}</div>
          <div className="flex gap8 wrap mt8">
            <span className="baseline-tag">
              基线 {c.baseline.reportNo}#r{c.baseline.revision} · {c.baseline.reportHash.slice(0, 16)}…
            </span>
            <span className="tiny muted mono">{c.commentId}</span>
            {c.changedFields && c.changedFields.length > 0 && (
              <span className="tiny tone-warn">变化字段：{c.changedFields.join('、')}</span>
            )}
          </div>
        </div>
      ))}
    </Card>
  );
}

function AuditTab() {
  const s = useStore();
  const [type, setType] = useState<string>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const events = s.audit.filter((e) => type === 'all' || e.type === type);

  return (
    <Card
      title={`审计账本（${s.audit.length}）`}
      sub="只追加。即使许可撤销、旧包冻结，已签署交付的审计摘要（包ID/报告哈希/签名/接收方/修订）仍保留可查。"
      extra={
        <select className="select" style={{ width: 220, padding: '6px 10px' }} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="all">全部事件类型</option>
          {Object.keys(AUDIT_ICON).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      }
    >
      {events.length === 0 && <Empty>暂无审计事件。</Empty>}
      {events.map((e) => (
        <div className="audit-item" key={e.eventId}>
          <div className="audit-icon">{AUDIT_ICON[e.type] ?? '•'}</div>
          <div className="audit-main">
            <div className="audit-summary">{e.summary}</div>
            <div className="audit-meta">
              <span>{e.type}</span>
              <span>{e.actorName}</span>
              <span>{new Date(e.at).toLocaleString('zh-CN')}</span>
              {(e.detail || e.signedDeliverySummary) && (
                <button className="btn btn-subtle btn-sm" onClick={() => setOpenId(openId === e.eventId ? null : e.eventId)}>
                  {openId === e.eventId ? '收起详情' : '详情'}
                </button>
              )}
            </div>
            {e.signedDeliverySummary && (
              <div className="audit-detail">
                <div className="small">
                  🧾 已签署交付摘要：包 <code>{e.signedDeliverySummary.packageId}</code> · 接收方{' '}
                  {e.signedDeliverySummary.receiverAccountId} · r{e.signedDeliverySummary.revision}
                </div>
                <div className="small mt8">
                  reportHash <Hash value={e.signedDeliverySummary.reportHash} head={20} tail={12} />
                </div>
                <div className="small mt8">
                  signature <Hash value={e.signedDeliverySummary.signature} head={20} tail={12} />
                </div>
              </div>
            )}
            {openId === e.eventId && e.detail && (
              <div className="audit-detail">
                <pre>{JSON.stringify(e.detail, null, 2)}</pre>
              </div>
            )}
          </div>
        </div>
      ))}
      <div className="mt16">
        <Btn variant="ghost" size="sm" onClick={() => s.setTab('packages')}>
          前往交付包核对 →
        </Btn>
      </div>
    </Card>
  );
}
