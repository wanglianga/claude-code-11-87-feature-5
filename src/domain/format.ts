import { getContract } from './contracts';

// ============================================================
// 数值 / 单位 / 空值 / 检出限的统一表达
// 关键纪律：先判检出限，再做舍入；低于检出限输出 “<0.1”，
// 绝不能先 toFixed(1) 把 0.04 变成 0.0。
// ============================================================

/** 消除浮点误差的定点舍入：roundToScale(12.04, 1) === 12.0 */
export function roundToScale(value: number, scale: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** scale;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function formatScaled(value: number, scale: number): string {
  return roundToScale(value, scale).toFixed(scale);
}

export interface MeasureDisplay {
  /** 投影后的机器值：低于检出限时为 null（语义由 belowDetectionLimit 表达） */
  value: number | null;
  display: string;
  belowDetectionLimit: boolean;
  transformed: 'below_lod' | 'rounded' | 'none';
}

/** 按字段契约处理测量值（含检出限优先判定） */
export function formatMeasure(fieldKey: string, raw: number | null): MeasureDisplay {
  const contract = getContract(fieldKey);
  if (raw === null || raw === undefined) {
    return { value: null, display: '未测量（null）', belowDetectionLimit: false, transformed: 'none' };
  }
  const scale = contract.scale ?? 2;
  const lod = contract.detectionLimit;
  if (lod !== undefined && raw < lod) {
    return {
      value: null,
      display: `<${lod.toFixed(scale)} ${contract.unit ?? ''}`.trim(),
      belowDetectionLimit: true,
      transformed: 'below_lod',
    };
  }
  const rounded = roundToScale(raw, scale);
  return {
    value: rounded,
    display: `${rounded.toFixed(scale)} ${contract.unit ?? ''}`.trim(),
    belowDetectionLimit: false,
    transformed: 'rounded',
  };
}

/** 坐标按契约 0.1 m 精度投影 */
export function formatCoordinate(coord: { x: number; y: number } | null): {
  display: string;
  x: string;
  y: string;
} | null {
  if (!coord) return null;
  const c = getContract('coordinate');
  const scale = c.scale ?? 1;
  const x = formatScaled(coord.x, scale);
  const y = formatScaled(coord.y, scale);
  return { x, y, display: `(${x}, ${y}) ${c.unit ?? ''}` };
}

export function enumLabel(fieldKey: string, value: string | null): string {
  if (value === null || value === undefined) return getContract(fieldKey).nullMeaning;
  const v = getContract(fieldKey).enumValues?.find((e) => e.value === value);
  return v ? v.label : value;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '尚未核验（null）';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

export function shortHash(h: string, head = 12, tail = 6): string {
  if (!h) return '';
  if (h.length <= head + tail + 1) return h;
  return `${h.slice(0, head)}…${h.slice(-tail)}`;
}
