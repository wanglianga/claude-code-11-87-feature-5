import { useState } from 'react';
import { useStore } from '../state/store';
import { ACCOUNTS } from '../domain/seed';
import { ROLE_LABELS, PURPOSE_LABELS } from '../domain/contracts';
import { serializePackageDownload } from '../domain/package';
import type { DeliveryPackage, Purpose, ValidationReport } from '../types';
import { Btn, Card, Badge, Hash, Modal, toneFromStatus, Empty } from './ui';
import { ValidationPanel } from './ProjectionViews';

function triggerDownload(pkg: DeliveryPackage) {
  const blob = serializePackageDownload(pkg);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${pkg.reportNo}_r${pkg.revision}_${pkg.receiverAccountId}_${pkg.packageId}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export default function Packages() {
  const s = useStore();
  const [receiverId, setReceiverId] = useState('u-builder');
  const [revision, setRevision] = useState(1);
  const [purpose, setPurpose] = useState<Purpose>('deliver');
  const [busy, setBusy] = useState(false);
  const [formMsg, setFormMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [validation, setValidation] = useState<ValidationReport | null>(null);
  const [validatingId, setValidatingId] = useState<string | null>(null);

  if (!s.server) return null;
  const report = s.server.reports.R1;

  async function materialize() {
    setBusy(true);
    setFormMsg(null);
    const r = await s.materializePackage(receiverId, revision, purpose);
    setFormMsg({ ok: r.ok, text: r.message });
    setBusy(false);
  }

  async function release(pkg: DeliveryPackage) {
    const r = await s.releasePackage(pkg.packageId);
    if (r.ok && r.pkg) {
      triggerDownload(r.pkg);
      s.notify('ok', `${r.message} 交付包 JSON 已开始下载。`);
    } else {
      s.notify('err', r.message);
    }
  }

  async function revalidate(pkg: DeliveryPackage) {
    setValidatingId(pkg.packageId);
    const v = await s.revalidatePackage(pkg.packageId);
    setValidation(v);
    setValidatingId(null);
  }

  return (
    <div>
      <div className="grid-2">
        <Card title="预物化签名交付包" sub="生成时固定报告修订、来源哈希、契约版本与许可版本；HMAC 签名覆盖投影与清单。重复交付直接释放，速度快且支持离线审阅。释放/下载瞬间仍会再次复核授权。">
          <div className="form-grid">
            <div className="form-row">
              <label>接收方</label>
              <select className="select" value={receiverId} onChange={(e) => setReceiverId(e.target.value)}>
                {ACCOUNTS.filter((a) => a.role !== 'admin').map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.displayName} · {ROLE_LABELS[a.role]}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <label>固定报告修订</label>
              <select className="select" value={revision} onChange={(e) => setRevision(Number(e.target.value))}>
                {report.revisions.map((r) => (
                  <option key={r.revision} value={r.revision}>
                    R1 修订 {r.revision}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <label>用途</label>
              <select className="select" value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)}>
                <option value="deliver">{PURPOSE_LABELS.deliver}</option>
                <option value="review">{PURPOSE_LABELS.review}</option>
                <option value="audit">{PURPOSE_LABELS.audit}</option>
              </select>
            </div>
          </div>
          <Btn variant="primary" onClick={materialize} disabled={busy}>
            {busy ? <><span className="spin" /> 编译/签名/校验中…</> : '🔏 物化并签名新包'}
          </Btn>
          {formMsg && <div className={`step-msg mt12 ${formMsg.ok ? 'ok' : 'err'}`}>{formMsg.text}</div>}
        </Card>

        <Card title="两种交付模式的纪律" sub="无论哪种模式，授权撤销后的新请求都不得释放旧包；已签署交付的审计摘要永久保留。">
          <div className="check-list">
            <div className="check pass">
              <span className="check-icon">📦</span>
              <div>
                <div className="check-label">预物化包（本页）</div>
                <div className="check-detail">
                  带项目/角色/修订与许可版本签名；重复交付快、离线可审阅。生成与实际释放时<b>两次</b>复核授权版本；撤销、版本漂移或报告修订后停止新下载并引导重建。
                </div>
              </div>
            </div>
            <div className="check pass">
              <span className="check-icon">⚡</span>
              <div>
                <div className="check-label">动态投影（「交付编译」页）</div>
                <div className="check-detail">
                  每次请求按当前字段策略实时生成，授权变化立即生效；同时实时校验来源版本、字段与附件一致性。
                </div>
              </div>
            </div>
            <div className="check warn">
              <span className="check-icon">🔒</span>
              <div>
                <div className="check-label">离线不可改写签名交付</div>
                <div className="check-detail">离线工作区只能新增/编辑带基线的审阅意见与回执草案；任何对签名包的改写尝试都会被拒绝并写入审计。</div>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <Card title={`交付包登记（${s.packages.length}）`} sub="包含首次启动预物化的三个角色包；状态实时反映释放闸门结论。">
        {s.packages.length === 0 && <Empty>尚无交付包。</Empty>}
        <div className="pkg-grid">
          {s.packages.map((p) => (
            <div className="pkg-card" key={p.packageId}>
              <div className="flex gap8 wrap mb8">
                <span className="pkg-id">{p.packageId}</span>
                <Badge tone={toneFromStatus(p.status)}>
                  {p.status === 'available' ? '可释放' : p.status === 'superseded' ? '已被新修订取代' : '释放已冻结'}
                </Badge>
                <Badge tone="brand">{p.kind === 'materialized' ? '预物化' : '动态快照'}</Badge>
                {p.tampered && <Badge tone="danger">内容被篡改</Badge>}
              </div>
              <dl className="kv">
                <dt>接收方</dt>
                <dd>
                  {p.receiverName} · {ROLE_LABELS[p.receiverRole]}
                </dd>
                <dt>报告修订</dt>
                <dd>
                  {p.reportNo} r{p.revision}（{PURPOSE_LABELS[p.purpose]}）
                </dd>
                <dt>固定许可</dt>
                <dd className="mono tiny">
                  {p.pins.licenseId} · v{p.pins.licenseVersionAtMaterialize} · 契约 {p.pins.contractVersion}
                </dd>
                <dt>报告哈希</dt>
                <dd>
                  <Hash value={p.reportHash} head={18} tail={10} />
                </dd>
                <dt>签名</dt>
                <dd>
                  <Hash value={p.signature} head={18} tail={10} />
                </dd>
                <dt>交付次数</dt>
                <dd>
                  {p.downloadCount} 次{p.lastReleaseAt ? ` · 最近 ${new Date(p.lastReleaseAt).toLocaleString('zh-CN')}` : ''}
                </dd>
              </dl>
              <div className="btn-row mt12">
                <Btn size="sm" variant="primary" onClick={() => release(p)}>
                  ⬇ 复核并释放/下载
                </Btn>
                <Btn size="sm" variant="ghost" onClick={() => revalidate(p)} disabled={validatingId === p.packageId}>
                  {validatingId === p.packageId ? '校验中…' : '重新校验'}
                </Btn>
                {s.server && s.server.reports[p.reportNo]?.currentRevision > p.revision && (
                  <Btn size="sm" variant="success" onClick={() => s.rebuildPackage(p.packageId)}>
                    按 r{s.server.reports[p.reportNo].currentRevision} 重建
                  </Btn>
                )}
              </div>
              <div className="btn-row mt8">
                <Btn size="sm" variant="subtle" onClick={() => s.tamperPackage(p.packageId)}>
                  🧪 模拟传输篡改
                </Btn>
                <Btn size="sm" variant="subtle" onClick={() => s.reportBlockedSignedEdit(p.packageId)}>
                  🔒 尝试离线改写签名内容
                </Btn>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Modal open={!!validation} onClose={() => setValidation(null)} title="包校验器报告（WebWorker）" width={820}>
        {validation && <ValidationPanel validation={validation} />}
      </Modal>
    </div>
  );
}
