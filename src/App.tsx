import { useMemo } from 'react';
import { useStore, type TabKey } from './state/store';
import { ACCOUNTS } from './domain/seed';
import { ROLE_LABELS } from './domain/contracts';
import { deriveLedger } from './domain/receipts';
import Login from './components/Login';
import ScenarioGuide from './components/ScenarioGuide';
import Studio from './components/Studio';
import Packages from './components/Packages';
import Review from './components/Review';
import Receipts from './components/Receipts';
import History from './components/History';
import Contracts from './components/Contracts';
import SemanticGate from './components/SemanticGate';
import { Toggle } from './components/ui';

const TABS: { key: TabKey; label: string; ico: string; title: string; crumb: string }[] = [
  { key: 'scenario', label: '场景推演', ico: '🧭', title: '端到端场景推演', crumb: 'P / R1 · 修订1→2 · 离线标注 · 撤销 · 冲突裁定' },
  { key: 'studio', label: '交付编译', ico: '⚙️', title: '授权投影编译器', crumb: '字段契约 × 六维授权交集 × WebWorker' },
  { key: 'packages', label: '签名交付包', ico: '📦', title: '物化包与释放闸门', crumb: '固定报告修订与许可版本 · 包校验 · 重复交付' },
  { key: 'review', label: '离线审阅', ico: '✍️', title: '离线审阅工作区', crumb: '带基线版本的意见 / 回执草案 · 按意见ID合并' },
  { key: 'receipts', label: '回执账', ico: '🧾', title: '交付回执账本', crumb: '传输 / 解析 / 语义确认 / 质疑 / 更正 · 冲突裁定' },
  { key: 'history', label: '版本与审计', ico: '🕓', title: '修订链 · 审阅历史 · 审计账本', crumb: '签名修订1保留 · 审计摘要不随授权撤销消失' },
  { key: 'contracts', label: '契约与授权', ico: '📐', title: '字段契约与授权交集', crumb: '类型 / 单位 / 精度 / 检出限 / 空值 / 枚举 / 来源 / 角色' },
  { key: 'semantic', label: '语义门禁', ico: '🛂', title: '语义行为契约与交付门禁', crumb: '不变量声明 · 冻结样本 · 探针 · 差分回放 · 变形测试 · 暂停交付' },
];

function Toast() {
  const { notice } = useStore();
  if (!notice) return null;
  return (
    <div className="toast-wrap">
      <div className={`toast ${notice.kind}`}>{notice.text}</div>
    </div>
  );
}

export default function App() {
  const s = useStore();

  const conflictCount = useMemo(() => {
    if (!s.server) return 0;
    const keys = new Set(s.receipts.map((r) => r.ledgerKey));
    let n = 0;
    for (const k of keys) {
      if (deriveLedger(k, s.receipts, s.server.adjudications).inConflict) n++;
    }
    return n;
  }, [s.receipts, s.server]);

  const pendingComments = s.localComments.filter((c) => c.syncState !== 'synced').length;

  if (!s.booted) {
    return (
      <div className="loading-screen">
        <div className="loading-card">
          <div className="spin dark" style={{ width: 34, height: 34, borderWidth: 3, margin: '0 auto 16px' }} />
          <div>正在打开 IndexedDB 并装载契约基线…</div>
        </div>
      </div>
    );
  }

  if (!s.account) {
    return (
      <>
        <Login />
        <Toast />
      </>
    );
  }

  const active = TABS.find((t) => t.key === s.tab)!;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">契</div>
          <div>
            <div className="brand-title">交付契约平台</div>
            <div className="brand-sub">DCP · Contract Delivery</div>
          </div>
        </div>
        <nav className="nav">
          {TABS.map((t) => (
            <button key={t.key} className={`nav-item ${s.tab === t.key ? 'active' : ''}`} onClick={() => s.setTab(t.key)}>
              <span className="ico">{t.ico}</span>
              {t.label}
              {t.key === 'review' && pendingComments > 0 && <span className="nav-count">{pendingComments}</span>}
              {t.key === 'receipts' && conflictCount > 0 && <span className="nav-count">{conflictCount}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div>字段契约版本 v2026.1</div>
          <div style={{ marginTop: 4 }}>IndexedDB 本地持久化</div>
          <div style={{ marginTop: 4 }}>编译/校验运行于 WebWorker</div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <h1>{active.title}</h1>
            <div className="crumb">{active.crumb}</div>
          </div>
          <div className="topbar-right">
            <span className={`pill-online ${s.online ? '' : 'tone-warn'}`}>
              <span className={`dot ${s.online ? 'on' : 'off'}`} />
              {s.online ? '网络在线' : '离线模式'}
            </span>
            <Toggle checked={s.online} onChange={s.setOnline} />
            <select
              className="select"
              style={{ width: 'auto', padding: '6px 10px' }}
              value={s.account.accountId}
              onChange={(e) => s.quickSwitch(e.target.value)}
              title="演示用：快速切换测试身份"
            >
              {ACCOUNTS.map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.displayName}（{ROLE_LABELS[a.role]}）
                </option>
              ))}
            </select>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                if (window.confirm('将清空 IndexedDB 中全部演示数据并重新播种，确定？')) void s.resetDemo();
              }}
            >
              重置演示
            </button>
            <button className="btn btn-subtle btn-sm" onClick={s.logout}>
              退出
            </button>
          </div>
        </header>

        <main className="content">
          {s.tab === 'scenario' && <ScenarioGuide />}
          {s.tab === 'studio' && <Studio />}
          {s.tab === 'packages' && <Packages />}
          {s.tab === 'review' && <Review />}
          {s.tab === 'receipts' && <Receipts />}
          {s.tab === 'history' && <History />}
          {s.tab === 'contracts' && <Contracts />}
          {s.tab === 'semantic' && <SemanticGate />}
        </main>
      </div>
      <Toast />
    </div>
  );
}
