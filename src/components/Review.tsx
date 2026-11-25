import { useMemo, useState } from 'react';
import { useStore } from '../state/store';
import { ACCOUNTS } from '../domain/seed';
import { ROLE_LABELS } from '../domain/contracts';
import { formatMeasure } from '../domain/format';
import { RECEIPT_LABELS } from '../domain/receipts';
import type { ReceiptType, ReviewComment } from '../types';
import { Btn, Card, Badge, Hash, Toggle, Empty } from './ui';

export default function Review() {
  const s = useStore();
  const reviewer =
    s.account && (s.account.role === 'builder' || s.account.role === 'supervisor') ? s.account : null;

  const [defectId, setDefectId] = useState('D-P-001');
  const [baselineRev, setBaselineRev] = useState(1);
  const [body, setBody] = useState('');
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState<'comments' | 'drafts'>('comments');

  const report = s.server?.reports.R1;
  const baseline = report?.revisions.find((r) => r.revision === baselineRev);
  const baselinePackage = s.packages.find(
    (p) => reviewer && p.receiverAccountId === reviewer.accountId && p.revision === baselineRev,
  );

  const defects = useMemo(() => {
    if (!baseline || !reviewer) return [];
    const license = s.licenseFor(reviewer.accountId, 'P');
    const sections = license?.sectionIds ?? reviewer.sectionIds ?? [];
    return baseline.defects.filter(
      (d) => sections.includes('*') || sections.includes(d.sectionId),
    );
  }, [baseline, reviewer, s]);

  if (!s.server || !report) return null;

  if (!reviewer) {
    return (
      <Card title="离线审阅工作区">
        <Empty>
          审阅意见必须以施工方或监理接收身份创建（意见要绑定作者与授权基线）。
          <div className="mt12">
            <Btn variant="primary" onClick={() => s.quickSwitch('u-builder')}>
              切换到施工方王建国
            </Btn>
          </div>
        </Empty>
      </Card>
    );
  }

  const visibleDefect = defects.find((d) => d.defectId === defectId) ?? defects[0];

  // 合并本地与服务端意见，按 ID 去重，本地副本优先（含同步/冲突状态）
  const commentMap = new Map<string, ReviewComment>();
  for (const c of s.server.serverComments) if (c.defectId) commentMap.set(c.commentId, c);
  for (const c of s.localComments) commentMap.set(c.commentId, c);
  const comments = [...commentMap.values()]
    .filter((c) => c.defectId === visibleDefect?.defectId)
    .sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));

  const myDrafts = s.drafts.filter((d) => d.receiverAccountId === reviewer.accountId);
  const pendingCount = s.localComments.filter((c) => c.syncState !== 'synced').length;

  async function submitComment() {
    if (!baseline || !body.trim()) return;
    await s.saveComment({
      commentId: editingId,
      defectId: visibleDefect.defectId,
      body,
      baseline: {
        reportNo: 'R1',
        revision: baselineRev,
        reportHash: baseline.reportHash,
        packageId: baselinePackage?.packageId,
      },
    });
    setBody('');
    setEditingId(undefined);
  }

  function startReReview(needsRev: number) {
    setBaselineRev(needsRev);
    setEditingId(undefined);
    setBody(
      `【修订${needsRev}重审】已知悉 D-P-001 裂缝宽度由 12.0mm 更正为 15.0mm，正在依据新基线重新核查…`,
    );
  }

  return (
    <div>
      {/* 离线状态条 */}
      <div className={`banner ${s.online ? 'banner-ok' : 'banner-warn'}`}>
        <span className="bi">{s.online ? '📶' : '📴'}</span>
        <div className="flex wrap gap12" style={{ width: '100%' }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <b>{s.online ? '在线工作区' : '离线工作区（IndexedDB 可持久编辑）'}</b>
            <div className="small">
              仅允许编辑<b>带基线版本</b>的审阅意见与回执草案；恢复联网后按<b>意见ID</b>合并。签名交付包本身不可离线改写。
            </div>
          </div>
          <Toggle checked={s.online} onChange={s.setOnline} />
          <Btn size="sm" variant="success" onClick={s.syncComments} disabled={!s.online}>
            立即同步合并{pendingCount > 0 ? `（${pendingCount} 条待同步）` : ''}
          </Btn>
        </div>
      </div>

      <div className="subtabs">
        <button className={`subtab ${tab === 'comments' ? 'active' : ''}`} onClick={() => setTab('comments')}>
          审阅意见（{s.localComments.length}）
        </button>
        <button className={`subtab ${tab === 'drafts' ? 'active' : ''}`} onClick={() => setTab('drafts')}>
          回执草案（{myDrafts.length}）
        </button>
      </div>

      {tab === 'drafts' ? (
        <DraftPanel receiverId={reviewer.accountId} />
      ) : (
        <div className="grid-side">
          {/* 左：本标段缺陷 */}
          <div>
            <Card title="可审阅缺陷" sub={`${ROLE_LABELS[reviewer.role]}视角 · 按授权标段过滤`}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {defects.map((d) => {
                  const w = formatMeasure('crackWidthMm', d.crackWidthMm);
                  return (
                    <button
                      key={d.defectId}
                      onClick={() => {
                        setDefectId(d.defectId);
                        setEditingId(undefined);
                      }}
                      className="defect-card"
                      style={{
                        textAlign: 'left',
                        cursor: 'pointer',
                        borderColor: visibleDefect?.defectId === d.defectId ? 'var(--brand)' : undefined,
                        boxShadow: visibleDefect?.defectId === d.defectId ? '0 0 0 2px rgba(27,95,208,.15)' : undefined,
                      }}
                    >
                      <div className="flex gap8">
                        <span className="defect-id">{d.defectId}</span>
                        <Badge tone="brand">{d.sectionId}</Badge>
                      </div>
                      <div className="small muted mt8">
                        宽度：
                        <b className={w.belowDetectionLimit ? 'value-lod' : ''}>{w.display}</b>
                        {d.crackWidthMm === null && <Badge tone="warn">未测量</Badge>}
                      </div>
                      <div className="small muted">状态：{d.rectificationStatus ?? '未填报(null)'}</div>
                    </button>
                  );
                })}
              </div>
            </Card>

            {/* 已签名基线包只读锁 */}
            {baselinePackage && (
              <Card title="基线签名交付包（只读）">
                <div className="small">
                  <div className="flex gap8 wrap mb8">
                    <Hash value={baselinePackage.packageId} head={16} tail={8} />
                    <Badge tone={baselinePackage.status === 'available' ? 'ok' : 'danger'}>
                      {baselinePackage.status}
                    </Badge>
                  </div>
                  <div>
                    报告哈希 <Hash value={baselinePackage.reportHash} />
                  </div>
                  <div className="mt8">
                    签名 <Hash value={baselinePackage.signature} />
                  </div>
                  <div className="mt12 btn-row">
                    <Btn size="sm" variant="danger" onClick={() => s.reportBlockedSignedEdit(baselinePackage.packageId)}>
                      🔒 尝试离线改写签名内容
                    </Btn>
                  </div>
                  <p className="tiny muted mt8">该尝试不会改动任何字节，但会写入审计：offline_edit_blocked。</p>
                </div>
              </Card>
            )}
          </div>

          {/* 右：意见串 + 编辑器 */}
          <div>
            {visibleDefect && (
              <Card
                title={
                  <span>
                    意见串 · <span className="mono">{visibleDefect.defectId}</span>
                  </span>
                }
                sub={visibleDefect.imageSummary ?? undefined}
                extra={
                  <select className="select" style={{ width: 230, padding: '5px 9px' }} value={baselineRev} onChange={(e) => setBaselineRev(Number(e.target.value))}>
                    {report.revisions.map((r) => (
                      <option key={r.revision} value={r.revision}>
                        新意见基线：R1 修订 {r.revision}
                        {r.revision === report.currentRevision ? '（当前）' : '（历史）'}
                      </option>
                    ))}
                  </select>
                }
              >
                {comments.length === 0 && <Empty>该缺陷暂无审阅意见。离线时也可在下方创建，会保存在 IndexedDB。</Empty>}

                {comments.map((c) => (
                  <div className="comment-card" key={c.commentId}>
                    <div className="comment-head">
                      <span className="comment-author">{c.authorName}</span>
                      <span className="comment-time">{new Date(c.updatedAt).toLocaleString('zh-CN')}</span>
                      <span className="spacer" />
                      <SyncBadge state={c.syncState} />
                    </div>
                    <div className="comment-body">{c.body}</div>
                    <div className="flex gap8 wrap mt8">
                      <span className="baseline-tag">
                        基线 {c.baseline.reportNo}#r{c.baseline.revision} · {c.baseline.reportHash.slice(0, 12)}…
                      </span>
                      <span className="tiny muted mono">ID {c.commentId}</span>
                    </div>

                    {c.needsReReviewFor && (
                      <div className="rereview-banner">
                        <span>⚠️</span>
                        <div style={{ flex: 1 }}>
                          该意见基于修订{c.baseline.revision}，而修订{c.needsReReviewFor}中本缺陷的「
                          {c.changedFields?.join('、')}」已变化；原意见保留为历史基线，<b>需对修订{c.needsReReviewFor}重新审阅</b>。旧包/旧确认不得视为新修订的确认。
                        </div>
                        <Btn size="sm" variant="warn" onClick={() => startReReview(c.needsReReviewFor!)}>
                          撰写重审意见
                        </Btn>
                      </div>
                    )}

                    {c.syncState === 'merge-conflict' && (
                      <div className="conflict-box">
                        <Badge tone="danger">同意见ID合并冲突</Badge>
                        <div className="conflict-cols">
                          <div className="conflict-version">
                            <h5>本地版本（{new Date(c.updatedAt).toLocaleString('zh-CN')}）</h5>
                            {c.body}
                          </div>
                          <div className="conflict-version">
                            <h5>服务端版本（{c.serverUpdatedAt ? new Date(c.serverUpdatedAt).toLocaleString('zh-CN') : ''}）</h5>
                            {c.serverBody}
                          </div>
                        </div>
                        <div className="btn-row">
                          <Btn size="sm" variant="primary" onClick={() => s.resolveConflict(c.commentId, 'local')}>
                            采用本地并重新合并
                          </Btn>
                          <Btn size="sm" variant="ghost" onClick={() => s.resolveConflict(c.commentId, 'server')}>
                            采用服务端
                          </Btn>
                        </div>
                      </div>
                    )}

                    {reviewer.accountId === c.authorAccountId && c.syncState !== 'merge-conflict' && (
                      <div className="mt8">
                        <Btn
                          size="sm"
                          variant="subtle"
                          onClick={() => {
                            setEditingId(c.commentId);
                            setBody(c.body);
                            setBaselineRev(c.baseline.revision);
                          }}
                        >
                          编辑（仍绑定原基线）
                        </Btn>
                      </div>
                    )}
                  </div>
                ))}

                <div className="composer mt12">
                  <div className="small mb8">
                    {editingId ? '编辑意见' : '新增意见'} · 基线固定为{' '}
                    <Badge tone="brand">
                      R1#r{baselineRev} · {baseline?.reportHash.slice(0, 14)}…
                    </Badge>
                    {!s.online && <Badge tone="warn">离线保存到 IndexedDB</Badge>}
                  </div>
                  <textarea
                    className="textarea"
                    style={{ minHeight: 92 }}
                    placeholder="记录复测结论、疑问或整改核验意见…"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                  />
                  <div className="btn-row mt8">
                    <Btn variant="primary" size="sm" onClick={submitComment} disabled={!body.trim()}>
                      {s.online ? '保存并同步' : '📴 离线保存（待同步）'}
                    </Btn>
                    {editingId && (
                      <Btn size="sm" variant="ghost" onClick={() => { setEditingId(undefined); setBody(''); }}>
                        取消编辑
                      </Btn>
                    )}
                  </div>
                </div>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SyncBadge({ state }: { state: ReviewComment['syncState'] }) {
  if (state === 'synced') return <Badge tone="ok">已按ID同步</Badge>;
  if (state === 'pending') return <Badge tone="warn">待合并</Badge>;
  if (state === 'merge-conflict') return <Badge tone="danger">合并冲突</Badge>;
  return <Badge tone="teal">仅本地/离线</Badge>;
}

// ---------------- 回执草案面板 ----------------
export function DraftPanel({ receiverId }: { receiverId: string }) {
  const s = useStore();
  const [revision, setRevision] = useState(1);
  const [type, setType] = useState<ReceiptType>('semantic_confirmed');
  const [note, setNote] = useState('');
  const drafts = s.drafts.filter((d) => d.receiverAccountId === receiverId);
  const acc = ACCOUNTS.find((a) => a.accountId === receiverId);

  return (
    <div className="grid-2">
      <Card title="新建回执草案" sub="离线时也可填写并保存在 IndexedDB；草案不是回执，恢复联网后必须显式提交才入回执账。">
        <div className="form-grid">
          <div className="form-row">
            <label>报告修订</label>
            <select className="select" value={revision} onChange={(e) => setRevision(Number(e.target.value))}>
              <option value={1}>R1 修订1</option>
              <option value={2}>R1 修订2</option>
            </select>
          </div>
          <div className="form-row">
            <label>回执类型</label>
            <select className="select" value={type} onChange={(e) => setType(e.target.value as ReceiptType)}>
              {Object.entries(RECEIPT_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </div>
        <textarea className="textarea" placeholder="回执说明（可选）" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="mt12">
          <Btn
            variant="primary"
            onClick={() =>
              s.saveDraft({ receiverAccountId: receiverId, projectId: 'P', reportNo: 'R1', revision, type, note })
            }
          >
            保存草案（{acc?.displayName}）
          </Btn>
        </div>
      </Card>

      <Card title={`本机草案（${drafts.length}）`} sub="离线可编辑/删除；提交动作只在在线时成功。">
        {drafts.length === 0 && <Empty>暂无回执草案。</Empty>}
        {drafts.map((d) => (
          <div className="draft-item" key={d.draftId}>
            <div style={{ flex: 1 }}>
              <div className="flex gap8 wrap">
                <Badge tone="slate">R1 r{d.revision}</Badge>
                <Badge tone="brand">{RECEIPT_LABELS[d.type]}</Badge>
                <Badge tone="teal">草案</Badge>
              </div>
              {d.note && <div className="small mt8">{d.note}</div>}
              <div className="tiny muted mt8">{new Date(d.createdAt).toLocaleString('zh-CN')}</div>
            </div>
            <div className="btn-row" style={{ flexDirection: 'column' }}>
              <Btn size="sm" variant="success" onClick={() => s.submitDraft(d.draftId)} disabled={!s.online}>
                提交入账
              </Btn>
              <Btn size="sm" variant="ghost" onClick={() => s.deleteDraft(d.draftId)}>
                删除
              </Btn>
            </div>
          </div>
        ))}
        {!s.online && drafts.length > 0 && (
          <div className="banner banner-warn mt12">当前离线：提交被阻止，草案继续保留。</div>
        )}
      </Card>
    </div>
  );
}
