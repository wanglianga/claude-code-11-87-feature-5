import { useState } from 'react';
import { useStore } from '../state/store';
import { ACCOUNTS } from '../domain/seed';
import { GROUP_LABELS, ROLE_LABELS } from '../domain/contracts';
import { workerApi } from '../state/workerClient';
import type { Projection, Purpose, ValidationReport } from '../types';
import { Btn, Card, Badge } from './ui';
import { ProjectionView } from './ProjectionViews';

interface StudioResult {
  projection: Projection;
  validation: ValidationReport | null;
  ms: number;
}

export default function Studio() {
  const s = useStore();
  const [receiverId, setReceiverId] = useState('u-builder');
  const [projectId, setProjectId] = useState('P');
  const [revision, setRevision] = useState(1);
  const [purpose, setPurpose] = useState<Purpose>('deliver');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<StudioResult | null>(null);
  const [error, setError] = useState('');

  if (!s.server) return null;
  const reports = Object.values(s.server.reports);
  const report = reports.find((r) => r.projectId === projectId) ?? reports[0];
  const revOptions = report.revisions.map((r) => r.revision);
  const effectiveRevision = revOptions.includes(revision) ? revision : report.currentRevision;
  const acc = ACCOUNTS.find((a) => a.accountId === receiverId)!;
  const license = s.licenseFor(receiverId, report.projectId);

  async function generate() {
    setBusy(true);
    setError('');
    try {
      const at = new Date().toISOString();
      const rev = report.revisions.find((r) => r.revision === effectiveRevision)!;
      const attachmentMap = new Map(s.attachments.map((a) => [a.attachmentId, a]));
      const t0 = performance.now();
      const projection = await workerApi.compile({
        report,
        revision: effectiveRevision,
        account: acc,
        license,
        purpose,
        mode: 'dynamic',
        atIso: at,
        attachmentMap,
      });

      let validation: ValidationReport | null = null;
      if (license) {
        const built = await workerApi.buildPackage({
          kind: 'dynamic',
          report,
          projection,
          account: acc,
          purpose,
          licenseId: license.licenseId,
          licenseVersionAtMaterialize: license.licenseVersion,
          sourceReportHash: rev.reportHash,
          atIso: at,
          validatorContext: { revision: rev, attachments: s.attachments, currentLicense: license },
        });
        validation = built.validation;
      }
      const ms = Math.round(performance.now() - t0);
      setResult({ projection, validation, ms });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const presets: { label: string; run: () => void }[] = [
    {
      label: '施工方 · P/R1/r1',
      run: () => {
        setReceiverId('u-builder');
        setProjectId('P');
        setRevision(1);
        setPurpose('deliver');
      },
    },
    {
      label: '监理 · 授权附件索引',
      run: () => {
        setReceiverId('u-supervisor');
        setProjectId('P');
        setRevision(1);
        setPurpose('deliver');
      },
    },
    {
      label: '审计 · 签名修订链',
      run: () => {
        setReceiverId('u-auditor');
        setProjectId('P');
        setRevision(1);
        setPurpose('audit');
      },
    },
    {
      label: '审计访问无关项目 Q（应拒绝）',
      run: () => {
        setReceiverId('u-auditor');
        setProjectId('Q');
        setRevision(1);
        setPurpose('audit');
      },
    },
    {
      label: '施工方 · 修订2 动态投影',
      run: () => {
        setReceiverId('u-builder');
        setProjectId('P');
        setRevision(2);
        setPurpose('review');
      },
    },
  ];

  return (
    <div>
      <Card title="动态投影编译器" sub="每次请求按当前字段策略与当前授权实时编译；授权变化立即生效，并实时校验来源版本、字段与附件一致性。编译与校验在 WebWorker 中运行。">
        <div className="form-grid mb12">
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
            <label>项目</label>
            <select className="select" value={projectId} onChange={(e) => { setProjectId(e.target.value); setRevision(1); }}>
              {Object.values(s.server.reports).map((r) => (
                <option key={r.reportNo} value={r.projectId}>
                  {r.projectId} · {r.reportNo}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label>报告修订（固定）</label>
            <select className="select" value={effectiveRevision} onChange={(e) => setRevision(Number(e.target.value))}>
              {revOptions.map((r) => (
                <option key={r} value={r}>
                  修订 {r}
                  {r === report.currentRevision ? '（当前）' : '（历史签署）'}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label>用途</label>
            <select className="select" value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)}>
              <option value="deliver">正式交付</option>
              <option value="review">审阅/离线标注</option>
              <option value="audit">审计查证</option>
            </select>
          </div>
        </div>

        <div className="flex gap8 wrap mb12">
          {presets.map((p) => (
            <Btn key={p.label} size="sm" variant="ghost" onClick={p.run}>
              {p.label}
            </Btn>
          ))}
        </div>

        <div className="flex gap12 wrap" style={{ alignItems: 'center' }}>
          <Btn variant="primary" onClick={generate} disabled={busy}>
            {busy ? <><span className="spin" /> Worker 编译校验中…</> : '⚡ 实时生成动态投影并校验'}
          </Btn>
          {license ? (
            <span className="small">
              当前许可 <b>{license.licenseId}</b> · v{license.licenseVersion} · 字段组{' '}
              {license.fieldGroups.map((g) => GROUP_LABELS[g]).join('/')} · 状态{' '}
              <Badge tone={license.status === 'active' ? 'ok' : 'danger'}>
                {license.status === 'active' ? '有效' : '已撤销'}
              </Badge>
            </span>
          ) : (
            <Badge tone="danger">该接收方在此项目无任何许可 —— 编译器将拒绝全部字段</Badge>
          )}
          <span className="spacer" />
          {result && license && (
            <Btn
              size="sm"
              variant="success"
              onClick={async () => {
                const r = await s.materializePackage(receiverId, effectiveRevision, purpose);
                if (r.ok) s.setTab('packages');
              }}
            >
              将此投影物化为签名包
            </Btn>
          )}
        </div>
        {error && <div className="banner banner-danger mt12">Worker 执行失败：{error}</div>}
      </Card>

      {result ? (
        <ProjectionView projection={result.projection} validation={result.validation} workerMs={result.ms} />
      ) : (
        <Card>
          <div className="empty">
            选择接收方、项目、修订与用途后点击「实时生成动态投影」。
            <div className="small mt8">建议依次尝试五个预设，观察不同角色的字段交集与过滤原因。</div>
          </div>
        </Card>
      )}
    </div>
  );
}
