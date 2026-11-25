import type { SemanticFieldContract } from '../../types';
import { FIELD_CONTRACTS } from '../contracts';
import { sha256Canonical } from '../hash';

// ============================================================
// 语义行为契约（Semantic Behavior Contract）
// 结构签名只能证明“字段还在”，本模块声明每个字段“必须被如何解释”：
// 单位换算因子、空值纪律、舍入/检出限顺序、枚举值域、过滤不变量、
// 聚合口径。探针 / 差分回放 / 变形测试 / 交付门禁全部以这些声明为准。
// ============================================================

/** 语义契约模式版本：语义声明结构本身变化时递增 */
export const SEMANTIC_CONTRACT_VERSION = 'sc-2026.1';

const AGG_RULE_WIDTH =
  '聚合口径：仅纳入已量化读数；null（未测量）与 <检出限（亚检出限）一律不得按 0 计入求和/均值，计数分母同时排除二者。';

/**
 * 机器可执行的字段语义契约。
 * 与 FIELD_CONTRACTS 的描述性文字不同，这里的因子/域/纪律可被探针直接断言。
 */
export const SEMANTIC_FIELD_CONTRACTS: SemanticFieldContract[] = [
  {
    fieldKey: 'crackWidthMm',
    label: '裂缝宽度',
    valueType: 'decimal',
    canonicalUnit: 'mm',
    // 消费方以其他单位接收时必须采用的乘性换算因子：canonical = received * factor
    unitConversions: [
      { unit: 'mm', factor: 1 },
      { unit: 'cm', factor: 10 },
      { unit: 'm', factor: 1000 },
      { unit: 'μm', factor: 0.001 },
    ],
    scale: 1,
    detectionLimit: 0.1,
    nullPolicy: 'preserve_null',
    roundingInvariant: true,
    filterInvariant: true,
    aggregationRule: AGG_RULE_WIDTH,
    invariantStatements: [
      { kind: 'unit', statement: '基准单位 mm；以 m/cm/μm 接收时必须按换算因子折算，禁止保留数字只换单位标签。' },
      {
        kind: 'rounding',
        statement: '先判检出限（0.1 mm）再按 1 位小数舍入；0.04 mm 必须输出 <0.1 mm，严禁先 toFixed(1) 变成 0.0。',
      },
      { kind: 'null', statement: 'null 表示未测量，必须保留 null 语义，禁止替换为 0、0.0、空串或“<0.1”。' },
      { kind: 'aggregation', statement: AGG_RULE_WIDTH },
      { kind: 'filter', statement: '未授权标段的宽度字段必须整体缺省，禁止用 0 或默认值补位。' },
    ],
  },
  {
    fieldKey: 'coordinate',
    label: '现场坐标',
    valueType: 'coordinate',
    canonicalUnit: 'm',
    unitConversions: [
      { unit: 'm', factor: 1 },
      { unit: 'mm', factor: 0.001 },
      { unit: 'km', factor: 1000 },
    ],
    scale: 1,
    nullPolicy: 'preserve_null',
    roundingInvariant: true,
    filterInvariant: true,
    invariantStatements: [
      { kind: 'unit', statement: '基准单位 m；源精度 0.001 m，交付精度固定 0.1 m，换算后仍按 0.1 m 舍入。' },
      { kind: 'null', statement: 'null 表示未采集坐标，绝不表示原点 (0, 0)，禁止补零。' },
      { kind: 'rounding', statement: 'x/y 分别按 1 位小数定点舍入，消除浮点误差。' },
      { kind: 'filter', statement: '未授权实体的坐标必须整体缺省。' },
    ],
  },
  {
    fieldKey: 'detectionMethod',
    label: '检测方法',
    valueType: 'enum',
    nullPolicy: 'preserve_null',
    enumDomain: ['visual', 'crack_gauge', 'ultrasonic', 'ground_penetrating_radar'],
    roundingInvariant: false,
    filterInvariant: true,
    invariantStatements: [
      { kind: 'enum', statement: '取值只能来自枚举域；null 表示未记录，禁止臆造为 visual（目视检查）。' },
      { kind: 'null', statement: 'null 必须原样保留并展示“未记录”语义，不得映射任何默认枚举。' },
      { kind: 'filter', statement: '未授权字段组下该字段必须缺省，而非返回空串占位。' },
    ],
  },
  {
    fieldKey: 'rectificationStatus',
    label: '整改状态',
    valueType: 'enum',
    nullPolicy: 'preserve_null',
    enumDomain: ['open', 'in_progress', 'rectified', 'verified'],
    roundingInvariant: false,
    filterInvariant: true,
    invariantStatements: [
      { kind: 'enum', statement: '取值只能来自枚举域；null 表示未填报，不等于 open（未整改）。' },
      { kind: 'null', statement: 'null 禁止默认成 open，否则会把“未填报”误判成“整改超期”。' },
      { kind: 'filter', statement: '未授权字段组下该字段必须缺省。' },
    ],
  },
  {
    fieldKey: 'verifiedAt',
    label: '核验时间',
    valueType: 'datetime',
    nullPolicy: 'preserve_null',
    roundingInvariant: false,
    filterInvariant: true,
    invariantStatements: [
      { kind: 'null', statement: 'null 表示尚未核验，禁止用纪元时间（1970-01-01）或空串伪装成具体时刻。' },
      { kind: 'filter', statement: '未授权字段组下该字段必须缺省。' },
    ],
  },
  {
    fieldKey: 'imageSummary',
    label: '影像摘要',
    valueType: 'string',
    nullPolicy: 'preserve_null',
    roundingInvariant: false,
    filterInvariant: true,
    invariantStatements: [
      { kind: 'null', statement: 'null 表示没有影像摘要，不等于“影像正常”，禁止生成默认文案。' },
      { kind: 'filter', statement: '未授权字段组下该字段必须缺省。' },
    ],
  },
  {
    fieldKey: 'sectionId',
    label: '施工标段',
    valueType: 'enum',
    nullPolicy: 'preserve_null',
    enumDomain: ['B1', 'B2'],
    roundingInvariant: false,
    filterInvariant: true,
    invariantStatements: [
      { kind: 'enum', statement: '标段取值只能来自枚举域；缺失时按“不授权”处理而非默认公开。' },
      { kind: 'filter', statement: '标段授权交集不通过时，该实体全部字段一起缺省。' },
    ],
  },
  {
    fieldKey: 'attachments',
    label: '影像附件引用',
    valueType: 'attachmentRefs',
    nullPolicy: 'not_applicable',
    roundingInvariant: false,
    filterInvariant: true,
    invariantStatements: [
      { kind: 'filter', statement: '未授权标段附件与未进入授权索引的附件必须被过滤，且过滤原因可追溯。' },
      { kind: 'null', statement: '空引用列表表示无附件，不得伪造占位引用。' },
    ],
  },
];

const SEMANTIC_MAP = new Map(SEMANTIC_FIELD_CONTRACTS.map((c) => [c.fieldKey, c]));

export function getSemanticContract(fieldKey: string): SemanticFieldContract {
  const c = SEMANTIC_MAP.get(fieldKey);
  if (!c) throw new Error(`未注册的语义行为契约: ${fieldKey}`);
  return c;
}

export function hasSemanticContract(fieldKey: string): boolean {
  return SEMANTIC_MAP.has(fieldKey);
}

/**
 * 策略指纹：把字段契约注册表 + 语义契约版本规范化后哈希。
 * 样本集与门禁报告固定此指纹；字段策略任何改动都会使旧回放绑定失效。
 */
export async function computePolicyFingerprint(): Promise<string> {
  return sha256Canonical({
    semanticContractVersion: SEMANTIC_CONTRACT_VERSION,
    fieldContracts: FIELD_CONTRACTS,
  });
}

/** 单位换算：把消费方单位下的读数折算回契约基准单位（canonical = received * factor） */
export function toCanonicalUnit(fieldKey: string, value: number, receivedUnit: string): number {
  const c = getSemanticContract(fieldKey);
  if (!c.canonicalUnit || !c.unitConversions) return value;
  if (receivedUnit === c.canonicalUnit) return value;
  const conv = c.unitConversions.find((u) => u.unit === receivedUnit);
  if (!conv) throw new Error(`字段 ${fieldKey} 未声明单位 ${receivedUnit} 的换算因子`);
  return value * conv.factor;
}
