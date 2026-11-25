import { useMemo, useState } from 'react';
import { useStore } from '../state/store';
import { ACCOUNTS } from '../domain/seed';
import {
  deriveLedger,
  LEDGER_STATE_LABELS,
  ledgerKeyOf,
  RECEIPT_LABELS,
  type LedgerView,
} from '../domain/receipts';
import type { ReceiptType } from '../types';
import { Btn, Card, Badge, toneFromStatus, Empty } from './ui';
import { DraftPanel } from './Review';

export default function Receipts() {
  const s = useStore();
  const [receiverId, setReceiverId] = useState('u-builder');
  const [revision, setRevision] = useState(2);
  const [type, setType] = useState<ReceiptType>('transmit_received');
  const [note, setNote] = useState('');
  const [showDrafts, setShowDrafts] = useState(false);

  const ledgers = useMemo<LedgerView[]>(() => {
    if (!s.server) return [];
    const keys = new Set<string>(s.receipts.map((r) => r.ledgerKey));
    // 已物化/交付的包也预建账本键，便于在没有回执时展示“暂无回执”
    for (const p of s.packages) keys.add(ledgerKeyOf(p.receiverAccountId, p.reportNo, p.revision));
    const list = [...keys].map((k) => deriveLedger(k, s.receipts, s.server!.adjudications));
    return list.sort((a, b) => Number(b.inConflict) - Number(a.inConflict));
  }, [s.receipts, s.server, s.packages]);

  const conflicts = ledgers.filter((l) => l.inConflict);

  return (
    <div>
      {conflicts.length > 0 && (
        <Card
          title={<span>⚖️ 冲突裁定队列（{conflicts.length}）</span>}
          sub="同一接收方对同一修订同时存在语义确认与质疑，账本不得自行选择，必须经管理员裁定。"
        >
          {conflicts.map((l) => (
            <LedgerCard key={l.key} ledger={l} highlight />
          ))}
        </Card>
      )}

      <div className="grid-2">
        <Card title="登记回执" sub="回执按接收方 × 报告修订独立建账；传输回执永远不会推导为语义确认。">
          <div className="form-grid">
            <div className="form-row">
              <label>接收方</label>
              <select className="select" value={receiverId} onChange={(e) => setReceiverId(e.target.value)}>
                {ACCOUNTS.filter((a) => a.role !== 'admin').map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.displayName}（{a.role}）
                  </option>
                ))}
              </select>
            </div>
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
          <textarea className="textarea" placeholder="回执说明" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="btn-row mt12">
            <Btn
              variant="primary"
              onClick={async () => {
                await s.addReceipt({ receiverAccountId: receiverId, reportNo: 'R1', revision, type, note: note || undefined });
                setNote('');
              }}
            >
              登记到回执账
            </Btn>
            <Btn variant="ghost" onClick={() => setShowDrafts((v) => !v)}>
              {showDrafts ? '收起回执草案' : '管理回执草案（离线可写）'}
            </Btn>
          </div>
          <div className="banner banner-info mt12">
            语义规则：只有「语义已确认」回执会置位 semanticConfirmed；追加再多「传输已收到」也不改变语义状态。确认与质疑并存且未裁定时为 conflict。
          </div>
        </Card>

        <Card title="状态口径">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>账本状态</th>
                  <th>含义</th>
                </tr>
              </thead>
              <tbody>
                <tr><td><Badge tone="teal">传输已收到</Badge></td><td className="small">仅证明字节送达（网关 ACK），不代表结构可解析，更不代表语义确认。</td></tr>
                <tr><td><Badge tone="warn">结构已解析</Badge></td><td className="small">JSON/清单/附件引用已成功解析。</td></tr>
                <tr><td><Badge tone="ok">语义已确认</Badge></td><td className="small">接收方确认字段精度、空值、检出限等语义与业务事实一致；严格绑定修订。</td></tr>
                <tr><td><Badge tone="danger">提出质疑</Badge></td><td className="small">对内容语义提出异议；与确认并存时进入冲突裁定。</td></tr>
                <tr><td><Badge tone="purple">被更正</Badge></td><td className="small">后续修订更正了该版本内容（如 12.0→15.0mm），旧版确认不延伸到新修订。</td></tr>
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {showDrafts && (
        <Card title="回执草案（IndexedDB · 离线可编辑）">
          <DraftPanel receiverId={receiverId} />
        </Card>
      )}

      <Card title={`回执账本（${ledgers.length} 本）`} sub="每本账 = 同一接收方对同一报告修订的全部回执，按时间追加、不可覆盖。">
        {ledgers.length === 0 && <Empty>暂无账本。</Empty>}
        <div className="ledger-grid">
          {ledgers.map((l) => (
            <LedgerCard key={l.key} ledger={l} />
          ))}
        </div>
      </Card>
    </div>
  );
}

function LedgerCard({ ledger, highlight = false }: { ledger: LedgerView; highlight?: boolean }) {
  const s = useStore();
  const [rationale, setRationale] = useState('');
  const [open, setOpen] = useState(highlight);

  return (
    <div className="ledger-card" style={highlight ? { borderColor: 'var(--danger)', boxShadow: '0 0 0 3px rgba(198,47,47,.12)' } : undefined}>
      <div className="ledger-head">
        <div className="flex gap8 wrap" style={{ alignItems: 'center' }}>
          <Badge tone={toneFromStatus(ledger.state)}>{LEDGER_STATE_LABELS[ledger.state]}</Badge>
          <span className="spacer" />
          <button className="btn btn-ghost btn-sm" onClick={() => setOpen((v) => !v)}>
            {open ? '收起明细' : `回执 ${ledger.receipts.length} 条`}
          </button>
        </div>
        <div className="ledger-key mt8">{ledger.key}</div>
        <div className="flag-row">
          <span className={`flag ${ledger.flags.transmit ? 'on' : ''}`}>传输{ledger.flags.transmit ? '✓' : '—'}</span>
          <span className={`flag ${ledger.flags.parsed ? 'on' : ''}`}>解析{ledger.flags.parsed ? '✓' : '—'}</span>
          <span className={`flag ${ledger.flags.confirmed ? 'on' : ''}`}>确认{ledger.flags.confirmed ? '✓' : '—'}</span>
          <span className={`flag ${ledger.flags.questioned ? 'on' : ''}`}>质疑{ledger.flags.questioned ? '✓' : '—'}</span>
          <span className={`flag ${ledger.flags.corrected ? 'on' : ''}`}>更正{ledger.flags.corrected ? '✓' : '—'}</span>
        </div>
        <div className="tiny muted mt8">
          语义确认位：<b className={ledger.semanticConfirmed ? 'tone-ok' : ''}>{String(ledger.semanticConfirmed)}</b>
          {ledger.adjudication && ` · 已裁定：${ledger.adjudication.outcome === 'uphold_confirmation' ? '确认有效' : '质疑成立'}`}
        </div>
      </div>

      {open && (
        <>
          {ledger.receipts.length === 0 ? (
            <div className="empty">尚无回执。</div>
          ) : (
            <ul className="timeline">
              {ledger.receipts.map((r) => (
                <li key={r.receiptId} className={`tl-item t-${r.type}`}>
                  <div className="tl-type">{RECEIPT_LABELS[r.type]}</div>
                  <div className="tl-meta">
                    {r.receiverName} · {new Date(r.at).toLocaleString('zh-CN')} · 来源 {r.source}
                  </div>
                  {r.note && <div className="tl-note">{r.note}</div>}
                </li>
              ))}
            </ul>
          )}

          {ledger.inConflict && (
            <div className="adjudicate-box">
              <Badge tone="danger">待管理员冲突裁定</Badge>
              <textarea
                className="textarea mt8"
                placeholder="裁定理由（将写入审计）"
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
              />
              <div className="btn-row mt8">
                {s.account?.role !== 'admin' ? (
                  <Btn size="sm" variant="primary" onClick={() => s.quickSwitch('u-admin')}>
                    切换管理员身份
                  </Btn>
                ) : (
                  <>
                    <Btn
                      size="sm"
                      variant="danger"
                      disabled={!rationale.trim()}
                      onClick={() => s.adjudicate(ledger.key, 'uphold_question', rationale)}
                    >
                      质疑成立 / 退回重审
                    </Btn>
                    <Btn
                      size="sm"
                      variant="success"
                      disabled={!rationale.trim()}
                      onClick={() => s.adjudicate(ledger.key, 'uphold_confirmation', rationale)}
                    >
                      确认有效
                    </Btn>
                  </>
                )}
              </div>
            </div>
          )}
          {ledger.adjudication && (
            <div className="adjudicate-box">
              <div className="small">
                <b>裁定理由：</b>
                {ledger.adjudication.rationale}
              </div>
              <div className="tiny muted mt8">
                {ledger.adjudication.adminAccountId} · {new Date(ledger.adjudication.at).toLocaleString('zh-CN')}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
