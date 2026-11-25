import { useEffect, useMemo, useState, cloneElement, isValidElement, type ReactElement } from 'react';
import { useStore } from '../state/store';
import { deriveLedger, LEDGER_STATE_LABELS, ledgerKeyOf } from '../domain/receipts';
import { Btn, Card, Badge } from './ui';

const SCENARIO_COMMENT_ID = 'CMT-SCENARIO-001';

interface VerifyResult {
  ok: boolean;
  lines: { ok: boolean; text: string }[];
}

export default function ScenarioGuide() {
  const s = useStore();
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [releaseMsg, setReleaseMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [rationale, setRationale] = useState(
    '核对修订2后确认：D-P-001 裂缝宽度已由 12.0 mm 更正为 15.0 mm，原“语义确认”基于修订1基线，不能覆盖修订2；裁定质疑成立，施工方须对修订2重新审阅确认。',
  );

  const report = s.server?.reports.R1;
  const r1 = report?.revisions.find((r) => r.revision === 1);
  const builderPkg = s.packages.find((p) => p.receiverAccountId === 'u-builder' && p.revision === 1);
  const builderLicense = s.server?.licenses.find((l) => l.licenseId === 'LIC-BUILDER-P-B1');
  const scenarioComment = s.localComments.find((c) => c.commentId === SCENARIO_COMMENT_ID);
  const mergedComment = s.server?.serverComments.find((c) => c.commentId === SCENARIO_COMMENT_ID);

  const r2Key = ledgerKeyOf('u-builder', 'R1', 2);
  const r2Ledger = useMemo(
    () => (s.server ? deriveLedger(r2Key, s.receipts, s.server.adjudications) : null),
    [r2Key, s.receipts, s.server],
  );
  const r1Key = ledgerKeyOf('u-builder', 'R1', 1);
  const r1Ledger = useMemo(
    () => (s.server ? deriveLedger(r1Key, s.receipts, s.server.adjudications) : null),
    [r1Key, s.receipts, s.server],
  );

  const hasTransmit = !!s.receipts.find((r) => r.ledgerKey === r2Key && r.type === 'transmit_received');
  const hasConfirm = !!s.receipts.find((r) => r.ledgerKey === r2Key && r.type === 'semantic_confirmed');
  const hasQuestion = !!s.receipts.find((r) => r.ledgerKey === r2Key && r.type === 'questioned');

  // ---------- 步骤2：核验预物化施工方投影 ----------
  function verifyProjection() {
    if (!builderPkg) return;
    const p = builderPkg.projection;
    const ids = p.defects.map((d) => d.defectId);
    const d002 = p.defects.find((d) => d.defectId === 'D-P-002');
    const d001 = p.defects.find((d) => d.defectId === 'D-P-001');
    const d003Decision = p.decisions.find((d) => d.entityId === 'D-P-003' && d.fieldKey === 'defectId');
    const a201 = p.decisions.find((d) => d.entityId === 'A-201');
    const lines = [
      { ok: ids.length === 3, text: `施工方仅得到本标段(B1) 3 条缺陷：${ids.join('、')}` },
      { ok: !ids.includes('D-P-003'), text: 'B2 标段缺陷 D-P-003 不出现在投影中' },
      { ok: (d001?.crackWidth?.display ?? '').includes('12.0'), text: `D-P-001 裂缝宽度按 0.1mm 契约显示：${d001?.crackWidth?.display}` },
      { ok: (d002?.crackWidth?.display ?? '').includes('<0.1'), text: `D-P-002 读数 0.04mm 低于检出限：${d002?.crackWidth?.display}（不是 0.0）` },
      { ok: !!d003Decision?.reasons.some((r) => r.code === 'section_not_authorized'), text: 'D-P-003 逐字段保留 section_not_authorized 过滤原因' },
      { ok: a201?.outcome === 'excluded', text: 'B2 照片 A-201 的引用/索引被过滤，施工方看不到未涉标段照片' },
    ];
    setVerify({ ok: lines.every((l) => l.ok), lines });
  }

  // ---------- 步骤3：离线意见 ----------
  async function createOfflineComment() {
    if (!r1 || !builderPkg) return;
    s.setOnline(false);
    await s.saveComment({
      commentId: SCENARIO_COMMENT_ID,
      defectId: 'D-P-001',
      body: '缺陷已复测：裂缝测宽仪复测读数约 12.0mm，已安排班组重新封闭处理。（施工方离线标注）',
      baseline: { reportNo: 'R1', revision: 1, reportHash: r1.reportHash, packageId: builderPkg.packageId },
    }, { offline: true });
  }

  async function goOnlineAndSync() {
    setSyncBusy(true);
    s.setOnline(true);
    // 等待 React 状态刷新出 online=true 后再同步
    await new Promise((r) => setTimeout(r, 60));
    await s.syncComments();
    setSyncBusy(false);
  }

  async function tryRelease() {
    if (!builderPkg) return;
    const res = await s.releasePackage(builderPkg.packageId);
    setReleaseMsg({ ok: res.ok, text: res.message });
  }

  const steps: { done: boolean; node: React.ReactNode }[] = [
    {
      done: s.account?.accountId === 'u-builder',
      node: (
        <Step
          index={1}
          title="以施工方身份进入"
          done={s.account?.accountId === 'u-builder'}
          desc="测试账号 builder / build1234，所属 B1 标段。"
          action={
            s.account?.accountId !== 'u-builder' ? (
              <Btn size="sm" variant="primary" onClick={() => s.quickSwitch('u-builder')}>
                切换到施工方王建国
              </Btn>
            ) : (
              <Badge tone="ok">当前已是施工方</Badge>
            )
          }
        />
      ),
    },
    {
      done: !!builderPkg,
      node: (
        <Step
          index={2}
          title="接收 R1 修订1 的预物化签名交付包"
          done={!!builderPkg}
          desc="系统首次启动已按 项目P / 施工方角色 / B1标段 / R1r1 预物化并签名，重复交付无需重新编译。"
          action={
            <Btn size="sm" variant="ghost" onClick={() => s.setTab('packages')}>
              前往「签名交付包」查看
            </Btn>
          }
        />
      ),
    },
    {
      done: !!verify?.ok,
      node: (
        <Step
          index={3}
          title="核验施工方投影边界（0.1m 坐标 / 0.1mm 宽度 / 检出限 / 标段照片）"
          done={!!verify?.ok}
          desc="编译器按字段契约与六维交集输出，并记录字段级原因。"
          action={
            <Btn size="sm" variant="primary" onClick={verifyProjection}>
              运行投影自检
            </Btn>
          }
        >
          {verify && (
            <div className={`step-msg ${verify.ok ? 'ok' : 'err'}`}>
              {verify.lines.map((l, i) => (
                <div key={i}>{l.ok ? '✅' : '❌'} {l.text}</div>
              ))}
            </div>
          )}
        </Step>
      ),
    },
    {
      done: scenarioComment?.body.includes('缺陷已复测') === true,
      node: (
        <Step
          index={4}
          title="离线标注“缺陷已复测”，意见强制绑定修订1基线"
          done={scenarioComment?.body.includes('缺陷已复测') === true}
          desc="动作会关闭网络并把意见写入 IndexedDB；离线只允许编辑带 baseline 的审阅意见与回执草案，签名交付不可改写。"
          action={
            <Btn size="sm" variant="primary" onClick={createOfflineComment}>
              📴 切离线并写入意见
            </Btn>
          }
        >
          {scenarioComment && (
            <div className="step-msg info">
              意见ID <code>{scenarioComment.commentId}</code> · 状态 {scenarioComment.syncState} · 基线 R1#r
              {scenarioComment.baseline.revision} · 哈希 {scenarioComment.baseline.reportHash.slice(0, 16)}…
            </div>
          )}
        </Step>
      ),
    },
    {
      done: builderLicense?.status === 'revoked',
      node: (
        <Step
          index={5}
          title="离线期间：施工方许可被撤销"
          done={builderLicense?.status === 'revoked'}
          desc="管理员撤销 LIC-BUILDER-P-B1。撤销后任何新请求/释放都不得再放出旧包。"
          action={
            builderLicense?.status !== 'revoked' ? (
              <Btn
                size="sm"
                variant="danger"
                onClick={() => s.revokeLicense('LIC-BUILDER-P-B1', '场景推演：授权范围复核，暂停施工方交付')}
              >
                撤销施工方许可
              </Btn>
            ) : (
              <Badge tone="danger">许可已撤销{builderLicense?.revokeReason ? `：${builderLicense.revokeReason}` : ''}</Badge>
            )
          }
        />
      ),
    },
    {
      done: (report?.currentRevision ?? 1) >= 2,
      node: (
        <Step
          index={6}
          title="报告发布修订2：裂缝宽度 12.0 → 15.0 mm"
          done={(report?.currentRevision ?? 1) >= 2}
          desc="修订2重新签署；修订1的签名与哈希原样保留，形成可追溯修订链。"
          action={
            (report?.currentRevision ?? 1) < 2 ? (
              <Btn size="sm" variant="primary" onClick={s.publishRevision2}>
                签署并发布修订2
              </Btn>
            ) : (
              <Badge tone="ok">当前修订 r{report?.currentRevision}</Badge>
            )
          }
        />
      ),
    },
    {
      done: scenarioComment?.syncState === 'synced' && scenarioComment?.needsReReviewFor === 2,
      node: (
        <Step
          index={7}
          title="恢复联网：按意见ID合并，并标记“需对修订2重审”"
          done={scenarioComment?.syncState === 'synced' && scenarioComment?.needsReReviewFor === 2}
          desc="同一 commentId 幂等合并不重复；基线停留在 r1，因 D-P-001 字段变化自动打上 r2 重审标记。"
          action={
            <Btn size="sm" variant="success" disabled={syncBusy} onClick={goOnlineAndSync}>
              {syncBusy ? '同步中…' : '📶 恢复联网并同步合并'}
            </Btn>
          }
        >
          {(mergedComment || scenarioComment) && (
            <div className="step-msg ok">
              服务端意见已按ID合并：{mergedComment?.commentId ?? scenarioComment?.commentId}；基线 r
              {(mergedComment ?? scenarioComment)?.baseline.revision} 保留；重审目标 r
              {(mergedComment ?? scenarioComment)?.needsReReviewFor ?? '—'}；变化字段：
              {(mergedComment ?? scenarioComment)?.changedFields?.join('、') || '无'}
            </div>
          )}
        </Step>
      ),
    },
    {
      done: builderPkg?.status === 'superseded' || builderPkg?.status === 'release_blocked' || releaseMsg !== null,
      node: (
        <Step
          index={8}
          title="旧包不得新下载，也不得作为修订2的确认"
          done={builderPkg?.status === 'superseded' || builderPkg?.status === 'release_blocked'}
          desc="释放闸门同时复核报告修订与当前授权版本；旧 r1 包被拦截，须按当前授权重建 r2 包。r1 的签署审计摘要仍保留。"
          action={
            <Btn size="sm" variant="danger" onClick={tryRelease}>
              尝试释放旧的修订1包
            </Btn>
          }
        >
          {releaseMsg && (
            <div className={`step-msg ${releaseMsg.ok ? 'ok' : 'err'}`}>
              {releaseMsg.ok ? '意外放行：' : '已拦截：'}
              {releaseMsg.text}
            </div>
          )}
        </Step>
      ),
    },
    {
      done: hasTransmit && r2Ledger?.state === 'transmit_received',
      node: (
        <Step
          index={9}
          title="收到“传输已收到”回执：不得记为语义确认"
          done={hasTransmit && r2Ledger?.state === 'transmit_received'}
          desc="向 builder::R1#r2 登记传输回执；语义确认位必须仍为 false。"
          action={
            !hasTransmit ? (
              <Btn
                size="sm"
                variant="primary"
                onClick={() =>
                  s.addReceipt({
                    receiverAccountId: 'u-builder',
                    reportNo: 'R1',
                    revision: 2,
                    type: 'transmit_received',
                    note: '网关 webhook：加密包已投递并收到 200 ACK。',
                  })
                }
              >
                登记“传输已收到”
              </Btn>
            ) : (
              <Badge tone="teal">台账状态：{r2Ledger ? LEDGER_STATE_LABELS[r2Ledger.state] : ''}；语义确认={String(r2Ledger?.semanticConfirmed)}</Badge>
            )
          }
        />
      ),
    },
    {
      done: !!r2Ledger?.adjudication,
      node: (
        <Step
          index={10}
          title="同一修订的“确认”与“质疑”矛盾 → 冲突裁定"
          done={!!r2Ledger?.adjudication}
          desc="同一接收方对 R1 r2 先确认又质疑，台账进入 conflict；管理员裁定后才落终态。"
          action={
            <div className="flex gap8 wrap">
              {!hasConfirm && (
                <Btn
                  size="sm"
                  variant="success"
                  onClick={() =>
                    s.addReceipt({ receiverAccountId: 'u-builder', reportNo: 'R1', revision: 2, type: 'semantic_confirmed', note: '回执草案：系统结构校验通过，语义无误。' })
                  }
                >
                  登记语义确认
                </Btn>
              )}
              {hasConfirm && <Badge tone="ok">已有语义确认</Badge>}
              {!hasQuestion && (
                <Btn
                  size="sm"
                  variant="danger"
                  onClick={() =>
                    s.addReceipt({ receiverAccountId: 'u-builder', reportNo: 'R1', revision: 2, type: 'questioned', note: '与修订1基线相比宽度变为15.0mm，需核实仪器与复测记录。' })
                  }
                >
                  同时提出质疑
                </Btn>
              )}
              {hasQuestion && <Badge tone="danger">已有质疑</Badge>}
            </div>
          }
        >
          {hasConfirm && hasQuestion && !r2Ledger?.adjudication && (
            <div className="conflict-box">
              <Badge tone="danger">冲突状态：{r2Ledger ? LEDGER_STATE_LABELS[r2Ledger.state] : ''}</Badge>
              <textarea className="textarea mt8" value={rationale} onChange={(e) => setRationale(e.target.value)} />
              <div className="btn-row mt8">
                {s.account?.role !== 'admin' ? (
                  <Btn size="sm" variant="primary" onClick={() => s.quickSwitch('u-admin')}>
                    切换到管理员进行裁定
                  </Btn>
                ) : (
                  <>
                    <Btn size="sm" variant="danger" onClick={() => s.adjudicate(r2Key, 'uphold_question', rationale)}>
                      裁定：质疑成立（需重审）
                    </Btn>
                    <Btn size="sm" variant="success" onClick={() => s.adjudicate(r2Key, 'uphold_confirmation', rationale)}>
                      裁定：确认有效
                    </Btn>
                  </>
                )}
              </div>
            </div>
          )}
          {r2Ledger?.adjudication && (
            <div className="step-msg ok">
              已裁定：{r2Ledger.adjudication.outcome === 'uphold_question' ? '质疑成立' : '确认有效'}。{r2Ledger.adjudication.rationale}
            </div>
          )}
        </Step>
      ),
    },
    {
      done: false,
      node: (
        <Step
          index={11}
          title="检查历史、审计与各专项工作台"
          done={false}
          desc="修订链保留签名 r1；审计账本保留已签署交付摘要、拦截、合并与裁定记录。可继续在「回执账」「离线审阅」中操作。"
          action={
            <div className="btn-row">
              <Btn size="sm" variant="ghost" onClick={() => s.setTab('history')}>
                版本与审计
              </Btn>
              <Btn size="sm" variant="ghost" onClick={() => s.setTab('receipts')}>
                回执账
              </Btn>
              <Btn size="sm" variant="ghost" onClick={() => s.setTab('review')}>
                离线审阅
              </Btn>
            </div>
          }
        />
      ),
    },
  ];

  const rawDone = steps.map((x) => x.done);
  const signature = rawDone.map(Number).join('');
  // 步骤一旦达成即永久打勾：后续台账状态演进（如追加确认/质疑）不应让已完成步骤回退
  const [achieved, setAchieved] = useState<boolean[]>(rawDone);
  useEffect(() => {
    setAchieved((prev) => {
      const base = prev.length === rawDone.length ? prev : rawDone;
      const next = rawDone.map((d, i) => Boolean(base[i]) || d);
      return next.some((v, i) => v !== base[i]) ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  const effectiveDone = rawDone.map((d, i) => achieved[i] || d);
  const doneCount = effectiveDone.filter(Boolean).length;

  return (
    <div>
      <Card className="scenario-hero" pad={false}>
        <div style={{ padding: 20 }}>
          <Badge tone="brand">固定剧本 · 可重复验证</Badge>
          <h2 style={{ fontSize: 19, margin: '10px 0 8px' }}>P 项目 · R1 报告 · 修订1 → 修订2 交付危机演练</h2>
          <p className="small" style={{ color: 'var(--ink-2)' }}>
            施工方只能看 B1 标段的缺陷ID、0.1m 精度位置、0.1mm 裂缝宽度与整改状态；监理看授权附件索引；审计看签名与修订链而不获得 Q
            项目记录。按下列步骤可完整验证题目要求的全部机制。所有数据在 IndexedDB 中真实流转，编译与校验在 WebWorker 中执行。
          </p>
          <div className="mt12">
            <div className="flex gap8 mb8">
              <b className="small">完成进度 {doneCount}/{steps.length - 1}</b>
              <span className="spacer" />
              <button className="btn btn-ghost btn-sm" onClick={() => window.location.reload()}>
                刷新页面观察持久化
              </button>
            </div>
            <div className="progress-track">
              <div className="progress-bar" style={{ width: `${(doneCount / (steps.length - 1)) * 100}%` }} />
            </div>
          </div>
        </div>
        <div style={{ padding: 20, borderLeft: '1px solid var(--line)', background: '#f8fafE' }}>
          <div className="form-label">关键台账实时状态</div>
          <div className="mt8" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="flex gap8">
              <Badge tone="slate">R1#r1 台账</Badge>
              <Badge tone={toneForState(r1Ledger?.state)}>{r1Ledger ? LEDGER_STATE_LABELS[r1Ledger.state] : '—'}</Badge>
            </div>
            <div className="flex gap8">
              <Badge tone="brand">R1#r2 台账</Badge>
              <Badge tone={toneForState(r2Ledger?.state)}>{r2Ledger ? LEDGER_STATE_LABELS[r2Ledger.state] : '暂无回执'}</Badge>
            </div>
            <div className="small muted mt8">
              r1 台账中的“被更正”标记由修订2发布时自动登记；r1 的确认（若有）在任何规则下都不会延伸为 r2 的确认。
            </div>
          </div>
        </div>
      </Card>

      <Card title="演练步骤">
        <div className="step-list">
          {steps.map((st, i) => {
            const node = isValidElement(st.node)
              ? cloneElement(st.node as ReactElement<{ done?: boolean }>, { done: effectiveDone[i] })
              : st.node;
            return <div key={i}>{node}</div>;
          })}
        </div>
      </Card>
    </div>
  );
}

function Step({
  index,
  title,
  desc,
  done,
  action,
  children,
}: {
  index: number;
  title: string;
  desc: string;
  done: boolean;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className={`step ${done ? 'done' : 'active'}`}>
      <div className="step-rail">
        <div className="step-dot">{done ? '✓' : index}</div>
        <div className="step-line" />
      </div>
      <div className="step-body">
        <div className="step-title">{title}</div>
        <div className="step-desc">{desc}</div>
        {action && <div>{action}</div>}
        {children}
      </div>
    </div>
  );
}

function toneForState(state?: string): 'ok' | 'danger' | 'warn' | 'purple' | 'teal' | 'slate' {
  switch (state) {
    case 'semantic_confirmed':
    case 'adjudicated_confirm':
      return 'ok';
    case 'conflict':
    case 'questioned':
    case 'adjudicated_question':
      return 'danger';
    case 'corrected':
    case 'superseded':
      return 'purple';
    case 'structure_parsed':
      return 'warn';
    case 'transmit_received':
      return 'teal';
    default:
      return 'slate';
  }
}
