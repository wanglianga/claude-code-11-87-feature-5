import { useState } from 'react';
import { ACCOUNTS } from '../domain/seed';
import { ROLE_LABELS } from '../domain/contracts';
import { Btn } from './ui';
import { useStore } from '../state/store';

export default function Login() {
  const { login } = useStore();
  const [username, setUsername] = useState('builder');
  const [password, setPassword] = useState('build1234');
  const [selected, setSelected] = useState('u-builder');
  const [err, setErr] = useState('');

  function pick(id: string) {
    const a = ACCOUNTS.find((x) => x.accountId === id)!;
    setSelected(id);
    setUsername(a.username);
    setPassword(a.password);
    setErr('');
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const a = login(username, password);
    if (!a) setErr('账号或密码不正确（可点击下方测试账号自动填充）。');
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-hero">
          <div className="flex gap12">
            <div className="brand-mark">契</div>
            <div>
              <div style={{ fontWeight: 800, fontSize: 17 }}>工程检测交付契约平台</div>
              <div style={{ fontSize: 12, color: '#9fb6dd' }}>Delivery Contract Platform · React + TypeScript + IndexedDB + WebWorker</div>
            </div>
          </div>
          <h1>让每一份检测报告，按字段契约与授权交集精准交付</h1>
          <p>
            字段精度 / 单位 / 检出限 / 空值语义强契约；项目 · 标段 · 角色 · 字段组 · 用途 · 有效期六维授权交集；
            固定修订与许可版本的签名包、包校验器、五态回执账、可合并的离线审阅意见与完整审计链。
          </p>
        </div>
        <div className="login-body">
          <div className="form-label" style={{ marginBottom: 4 }}>
            测试账号（点击卡片自动填充）
          </div>
          <div className="account-grid">
            {ACCOUNTS.map((a) => (
              <button
                type="button"
                key={a.accountId}
                className={`account-tile ${selected === a.accountId ? 'selected' : ''}`}
                onClick={() => pick(a.accountId)}
              >
                <div className="at-name">
                  {a.displayName} <span className="badge badge-brand">{ROLE_LABELS[a.role]}</span>
                </div>
                <div className="at-org">{a.org}</div>
                <div className="tiny mono muted">
                  {a.username} / {a.password}
                </div>
              </button>
            ))}
          </div>
          <form className="login-form" onSubmit={submit}>
            <div className="form-row">
              <label>账号</label>
              <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" />
            </div>
            <div className="form-row">
              <label>密码</label>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <Btn type="submit" variant="primary" size="md" style={{ padding: '9px 26px' }}>
              登录并进入控制台
            </Btn>
          </form>
          {err && <div className="banner banner-danger mt12">{err}</div>}
          <p className="small muted mt12">
            数据保存在本机 IndexedDB；本系统为交付契约演示，签名使用内置演示 HMAC 密钥，不用于真实生产签署。
          </p>
        </div>
      </div>
    </div>
  );
}
