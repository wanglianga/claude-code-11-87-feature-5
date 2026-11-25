import { useMemo, useState } from 'react';
import { FIELD_CONTRACTS, GROUP_LABELS, PURPOSE_LABELS, ROLE_LABELS } from '../domain/contracts';
import { ACCOUNTS, PROJECTS } from '../domain/seed';
import { evaluateFieldAccess, validityLabel, validityState } from '../domain/auth';
import type { FieldGroup, Purpose } from '../types';
import { useStore } from '../state/store';
import { Btn, Card, Badge } from './ui';

export default function Contracts() {
  return (
    <div>
      <ContractTable />
      <IntersectionSimulator />
      <LicenseAdmin />
    </div>
  );
}

function ContractTable() {
  return (
    <Card title="字段契约注册表" sub="每个交付字段明确类型、单位、舍入精度、空值含义、允许枚举、数据来源与契约可见角色；最终可见性还要与授权许可求交集。">
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>字段</th>
              <th>类型 / 单位 / 精度</th>
              <th>空值与检出限语义</th>
              <th>允许枚举</th>
              <th>来源</th>
              <th>可见角色</th>
            </tr>
          </thead>
          <tbody>
            {FIELD_CONTRACTS.map((c) => (
              <tr key={c.key}>
                <td style={{ minWidth: 150 }}>
                  <div style={{ fontWeight: 700 }}>{c.label}</div>
                  <div className="contract-key">{c.key}</div>
                  <Badge tone="slate">{GROUP_LABELS[c.group]}</Badge>
                  {c.required && <Badge tone="danger">必需</Badge>}
                </td>
                <td style={{ minWidth: 150 }}>
                  <div>{c.valueType}</div>
                  {c.unit && <div className="small">单位：<b>{c.unit}</b></div>}
                  {c.scale !== undefined && <div className="small">舍入：保留 <b>{c.scale}</b> 位小数</div>}
                  {c.detectionLimit !== undefined && (
                    <div className="small tone-purple">检出限：{c.detectionLimit} {c.unit}（低于即标“&lt;检出限”）</div>
                  )}
                </td>
                <td className="null-meaning" style={{ minWidth: 220 }}>{c.nullMeaning}</td>
                <td style={{ minWidth: 150 }}>
                  {c.enumValues ? (
                    <div className="role-chips">
                      {c.enumValues.map((e) => (
                        <Badge key={e.value} tone="slate" title={e.value}>
                          {e.label}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <span className="muted tiny">—</span>
                  )}
                </td>
                <td className="small" style={{ minWidth: 170 }}>{c.source}</td>
                <td>
                  <div className="role-chips">
                    {c.visibleRoles.map((r) => (
                      <Badge key={r} tone="brand">
                        {ROLE_LABELS[r]}
                      </Badge>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function IntersectionSimulator() {
  const s = useStore();
  const [accountId, setAccountId] = useState('u-builder');
  const [projectId, setProjectId] = useState('P');
  const [purpose, setPurpose] = useState<Purpose>('deliver');
  const [group, setGroup] = useState<FieldGroup>('measurement');
  const [sectionId, setSectionId] = useState<'__report__' | 'B1' | 'B2'>('B1');

  const account = ACCOUNTS.find((a) => a.accountId === accountId)!;
  const license = s.licenseFor(accountId, projectId);
  const result = useMemo(
    () =>
      evaluateFieldAccess({
        license,
        account,
        projectId,
        purpose,
        group,
        atIso: new Date().toISOString(),
        sectionId: sectionId === '__report__' ? undefined : sectionId,
      }),
    [license, account, projectId, purpose, group, sectionId],
  );

  return (
    <Card title="授权六维交集模拟器" sub="选择访问上下文，实时观察 项目 ∩ 标段 ∩ 角色 ∩ 字段组 ∩ 用途 ∩ 有效期 的逐维结论。">
      <div className="lattice mb16">
        <div className="form-row">
          <label>接收账号</label>
          <select className="select" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {ACCOUNTS.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.displayName}（{ROLE_LABELS[a.role]}）
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label>项目</label>
          <select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {PROJECTS.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.projectId} · {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label>用途</label>
          <select className="select" value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)}>
            {(Object.keys(PURPOSE_LABELS) as Purpose[]).map((p) => (
              <option key={p} value={p}>
                {PURPOSE_LABELS[p]}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label>字段组</label>
          <select className="select" value={group} onChange={(e) => setGroup(e.target.value as FieldGroup)}>
            {Object.entries(GROUP_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}（{k}）
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label>标段上下文</label>
          <select className="select" value={sectionId} onChange={(e) => setSectionId(e.target.value as typeof sectionId)}>
            <option value="B1">实体标段 B1</option>
            <option value="B2">实体标段 B2</option>
            <option value="__report__">报告级字段（不按标段）</option>
          </select>
        </div>
        <div className="form-row">
          <label>交集结论</label>
          <div>
            <Badge tone={result.allowed ? 'ok' : 'danger'} style={{ fontSize: 13, padding: '6px 12px' }}>
              {result.allowed ? '✓ 六维全部通过 · 字段可见' : '✕ 至少一维拒绝 · 字段过滤'}
            </Badge>
          </div>
        </div>
      </div>
      <div className="trace-grid">
        {result.traces.map((t) => (
          <div key={t.dimension} className={`trace-item ${t.passed ? 'pass' : 'fail'}`}>
            <div className="trace-dim">
              <span>{t.label}</span>
              <span>{t.passed ? '✓' : '✕'}</span>
            </div>
            <div className="trace-vals">
              <div className="req">要求：{t.required}</div>
              <div className="granted">许可：{t.granted}</div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function LicenseAdmin() {
  const s = useStore();
  if (!s.server) return null;
  return (
    <Card title="授权许可管理" sub="撤销或许可版本换发会立即影响动态投影与所有新的释放请求；已签署交付的审计摘要保留。">
      <div className="grid-2">
        {s.server.licenses.map((l) => {
          const state = validityState(l, new Date().toISOString());
          return <LicenseCard key={l.licenseId} licenseId={l.licenseId} stateLabel={validityLabel(state)} />;
        })}
      </div>
    </Card>
  );
}

function LicenseCard({ licenseId, stateLabel }: { licenseId: string; stateLabel: string }) {
  const s = useStore();
  const [reason, setReason] = useState('场景演练：授权复核未通过');
  const license = s.server!.licenses.find((l) => l.licenseId === licenseId)!;
  const acc = ACCOUNTS.find((a) => a.accountId === license.accountId);

  return (
    <div className="pkg-card">
      <div className="flex gap8 wrap mb8">
        <span className="pkg-id">{license.licenseId}</span>
        <Badge tone={license.status === 'active' ? 'ok' : 'danger'}>
          {stateLabel} · v{license.licenseVersion}
        </Badge>
      </div>
      <dl className="kv">
        <dt>被授权方</dt>
        <dd>{acc?.displayName}（{ROLE_LABELS[license.role]}）</dd>
        <dt>项目</dt>
        <dd>{license.projectId}</dd>
        <dt>标段</dt>
        <dd className="mono tiny">{license.sectionIds.join(', ') || '（无标段，仅项目级字段组）'}</dd>
        <dt>字段组</dt>
        <dd>{license.fieldGroups.map((g) => GROUP_LABELS[g]).join('、')}</dd>
        <dt>用途</dt>
        <dd>{license.purposes.map((p) => PURPOSE_LABELS[p]).join('、')}</dd>
        <dt>有效期</dt>
        <dd className="tiny">
          {license.validFrom}
          <br />→ {license.validUntil}
        </dd>
        {license.revokeReason && (
          <>
            <dt>撤销原因</dt>
            <dd className="small tone-danger">{license.revokeReason}</dd>
          </>
        )}
      </dl>
      <div className="mt12">
        <input className="input small" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="撤销原因" />
        <div className="btn-row mt8">
          {license.status === 'active' ? (
            <Btn size="sm" variant="danger" onClick={() => s.revokeLicense(license.licenseId, reason)}>
              立即撤销
            </Btn>
          ) : (
            <Badge tone="danger">已撤销</Badge>
          )}
          <Btn size="sm" variant="ghost" onClick={() => s.renewLicense(license.licenseId)}>
            换发并升级版本号
          </Btn>
        </div>
      </div>
    </div>
  );
}
