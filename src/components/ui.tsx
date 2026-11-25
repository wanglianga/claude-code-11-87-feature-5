import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useEffect } from 'react';
import { shortHash } from '../domain/format';

// ---------- Badge ----------
const TONES = ['slate', 'brand', 'ok', 'warn', 'danger', 'purple', 'teal'] as const;
export type Tone = (typeof TONES)[number];

export function Badge({ tone = 'slate', children, title, style }: { tone?: Tone; children: ReactNode; title?: string; style?: React.CSSProperties }) {
  return (
    <span className={`badge badge-${tone}`} title={title} style={style}>
      {children}
    </span>
  );
}

export function toneFromStatus(status: string): Tone {
  switch (status) {
    case 'pass':
    case 'available':
    case 'synced':
    case 'active':
    case 'semantic_confirmed':
    case 'adjudicated_confirm':
    case 'verified':
      return 'ok';
    case 'warn':
    case 'structure_parsed':
    case 'pending':
    case 'in_progress':
    case 'rectified':
      return 'warn';
    case 'fail':
    case 'release_blocked':
    case 'conflict':
    case 'merge-conflict':
    case 'questioned':
    case 'adjudicated_question':
    case 'open':
      return 'danger';
    case 'superseded':
    case 'corrected':
    case 'revoked':
    case 'expired':
      return 'purple';
    case 'local-only':
    case 'transmit_received':
      return 'teal';
    default:
      return 'slate';
  }
}

// ---------- Card ----------
export function Card({
  title,
  sub,
  extra,
  children,
  className = '',
  pad = true,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  pad?: boolean;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || extra) && (
        <header className="card-head">
          <div>
            {title && <h3 className="card-title">{title}</h3>}
            {sub && <p className="card-sub">{sub}</p>}
          </div>
          {extra && <div className="card-extra">{extra}</div>}
        </header>
      )}
      <div className={pad ? 'card-body' : 'card-body flush'}>{children}</div>
    </section>
  );
}

// ---------- Button ----------
interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger' | 'subtle' | 'success' | 'warn';
  size?: 'sm' | 'md';
}
export function Btn({ variant = 'subtle', size = 'md', className = '', ...rest }: BtnProps) {
  return <button className={`btn btn-${variant} btn-${size} ${className}`} {...rest} />;
}

// ---------- Stat ----------
export function Stat({ label, value, hint, tone = 'slate' }: { label: string; value: ReactNode; hint?: string; tone?: Tone }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value tone-${tone}`}>{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

// ---------- Hash ----------
export function Hash({ value, head, tail }: { value: string; head?: number; tail?: number }) {
  return (
    <code className="hash" title={value}>
      {shortHash(value, head, tail)}
    </code>
  );
}

// ---------- Modal ----------
export function Modal({
  open,
  onClose,
  title,
  children,
  width = 760,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: width }}>
        <header className="modal-head">
          <h3>{title}</h3>
          <button className="modal-x" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// ---------- Empty ----------
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

// ---------- Toggle ----------
export function Toggle({ checked, onChange, onLabel, offLabel }: { checked: boolean; onChange: (v: boolean) => void; onLabel?: string; offLabel?: string }) {
  return (
    <button type="button" className={`toggle ${checked ? 'on' : 'off'}`} onClick={() => onChange(!checked)}>
      <span className="toggle-knob" />
      <span className="toggle-text">{checked ? onLabel ?? '在线' : offLabel ?? '离线'}</span>
    </button>
  );
}

// ---------- Key-value ----------
export function KV({ k, children }: { k: ReactNode; children: ReactNode }) {
  return (
    <div className="kv">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}
