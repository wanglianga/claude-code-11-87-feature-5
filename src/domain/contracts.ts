import type { FieldContract } from '../types';

// ============================================================
// 字段契约注册表
// 每个交付字段明确：类型、单位、舍入精度、空值含义、允许枚举、
// 数据来源与契约可见角色。授权许可还会在此之上求交集。
// ============================================================

export const FIELD_CONTRACTS: FieldContract[] = [
  {
    key: 'reportNo',
    label: '报告号',
    group: 'identity',
    valueType: 'string',
    required: true,
    nullMeaning: '报告号由报告系统分配，任何交付投影中都不允许为空。',
    source: '检测报告管理系统 / 报告台账',
    visibleRoles: ['builder', 'supervisor', 'auditor', 'admin'],
    description: '报告的稳定业务编号，不随修订变化。',
  },
  {
    key: 'revision',
    label: '修订号',
    group: 'identity',
    valueType: 'integer',
    required: true,
    nullMeaning: '修订号缺失意味着无法固定语义基线，禁止交付。',
    source: '报告版本库（固定修订）',
    visibleRoles: ['builder', 'supervisor', 'auditor', 'admin'],
  },
  {
    key: 'defectId',
    label: '缺陷ID',
    group: 'identity',
    valueType: 'string',
    required: true,
    nullMeaning: '缺陷ID是意见合并与回执关联的锚点，不允许为空。',
    source: '缺陷台账',
    visibleRoles: ['builder', 'supervisor', 'admin'],
  },
  {
    key: 'sectionId',
    label: '施工标段',
    group: 'location',
    valueType: 'enum',
    required: true,
    nullMeaning: '标段缺失时无法做标段授权交集，默认按“不授权”处理而非公开。',
    enumValues: [
      { value: 'B1', label: 'B1 标段（K2+300~K3+100）' },
      { value: 'B2', label: 'B2 标段（K3+100~K3+900）' },
    ],
    source: '施工标段台账',
    visibleRoles: ['builder', 'supervisor', 'admin'],
  },
  {
    key: 'coordinate',
    label: '现场坐标',
    group: 'location',
    valueType: 'coordinate',
    unit: 'm',
    scale: 1,
    required: false,
    nullMeaning: 'null 表示该缺陷未采集坐标，绝不表示坐标为 (0, 0)；投影保留“未采集”语义。',
    source: '现场 RTK / 定位记录（源精度 0.001 m）',
    visibleRoles: ['builder', 'supervisor', 'admin'],
    description: '交付精度固定为 0.1 m，源坐标在投影时按契约舍入。',
  },
  {
    key: 'crackWidthMm',
    label: '裂缝宽度',
    group: 'measurement',
    valueType: 'decimal',
    unit: 'mm',
    scale: 1,
    detectionLimit: 0.1,
    required: true,
    nullMeaning:
      'null 表示未实施宽度测量；若有读数但低于仪器检出限 0.1 mm，必须输出“<0.1”而不是 0 或 0.0。',
    source: '裂缝测宽仪读数（估读 0.01 mm，检出限 0.1 mm）',
    visibleRoles: ['builder', 'supervisor', 'admin'],
    description: '以毫米为单位保留 0.1 mm；先判检出限，再做舍入，避免亚检出限读数被显示成 0。',
  },
  {
    key: 'detectionMethod',
    label: '检测方法',
    group: 'measurement',
    valueType: 'enum',
    required: true,
    nullMeaning: 'null 表示检测方法未记录，不能臆造为“目视”。',
    enumValues: [
      { value: 'visual', label: '目视检查' },
      { value: 'crack_gauge', label: '裂缝测宽仪' },
      { value: 'ultrasonic', label: '超声波检测' },
      { value: 'ground_penetrating_radar', label: '地质雷达' },
    ],
    source: '现场检测作业记录',
    visibleRoles: ['builder', 'supervisor', 'admin'],
  },
  {
    key: 'imageSummary',
    label: '影像摘要',
    group: 'media',
    valueType: 'string',
    required: false,
    nullMeaning: 'null 表示该缺陷没有影像摘要，不等于“影像正常”。',
    source: '影像管理系统（AI 摘要 + 人工复核）',
    visibleRoles: ['builder', 'supervisor', 'admin'],
  },
  {
    key: 'attachments',
    label: '影像附件引用',
    group: 'media',
    valueType: 'attachmentRefs',
    required: false,
    nullMeaning: '空引用列表表示无附件；引用必须通过附件哈希与标段授权校验。',
    source: '附件/影像库（SHA-256 完整性）',
    visibleRoles: ['builder', 'supervisor', 'admin'],
  },
  {
    key: 'attachmentIndex',
    label: '授权附件索引',
    group: 'attachmentIndex',
    valueType: 'attachmentRefs',
    required: false,
    nullMeaning: '仅列出通过“项目 + 标段 + 索引可见性”授权的附件；未列出不代表附件不存在。',
    source: '附件库授权索引服务',
    visibleRoles: ['supervisor', 'auditor', 'admin'],
    description: '监理默认获得索引而非影像原件，原件访问需另行授权。',
  },
  {
    key: 'rectificationStatus',
    label: '整改状态',
    group: 'workflow',
    valueType: 'enum',
    required: true,
    nullMeaning: 'null 表示整改状态未填报，不等于“未整改(open)”。',
    enumValues: [
      { value: 'open', label: '未整改' },
      { value: 'in_progress', label: '整改中' },
      { value: 'rectified', label: '已整改待核验' },
      { value: 'verified', label: '已核验闭环' },
    ],
    source: '施工整改管理系统',
    visibleRoles: ['builder', 'supervisor', 'admin'],
  },
  {
    key: 'verifiedAt',
    label: '核验时间',
    group: 'workflow',
    valueType: 'datetime',
    required: false,
    nullMeaning: 'null 表示尚未完成核验，禁止用纪元时间或空字符串伪装成具体时刻。',
    source: '监理/检测核验记录',
    visibleRoles: ['builder', 'supervisor', 'admin'],
  },
  {
    key: 'reportHash',
    label: '报告哈希',
    group: 'assurance',
    valueType: 'hash',
    required: true,
    nullMeaning: '报告哈希缺失意味着无法校验来源版本，禁止签署交付。',
    source: '交付平台哈希存证（SHA-256 规范化 JSON）',
    visibleRoles: ['auditor', 'admin'],
  },
  {
    key: 'signature',
    label: '数字签名',
    group: 'assurance',
    valueType: 'signature',
    required: true,
    nullMeaning: '签名缺失的包只能作为草稿，不得释放。',
    source: '检测机构签署密钥（演示环境为 HMAC-SHA256）',
    visibleRoles: ['auditor', 'admin'],
  },
  {
    key: 'revisionChain',
    label: '修订链',
    group: 'assurance',
    valueType: 'hash',
    required: true,
    nullMeaning: '修订链必须可逐版追溯，不允许出现断链。',
    source: '报告版本库 + 审计账本',
    visibleRoles: ['auditor', 'admin'],
  },
];

const CONTRACT_MAP = new Map(FIELD_CONTRACTS.map((c) => [c.key, c]));

export function getContract(key: string): FieldContract {
  const c = CONTRACT_MAP.get(key);
  if (!c) throw new Error(`未注册的字段契约: ${key}`);
  return c;
}

export const ROLE_LABELS: Record<string, string> = {
  builder: '施工单位',
  supervisor: '监理单位',
  auditor: '审计员',
  admin: '交付管理员',
};

export const GROUP_LABELS: Record<string, string> = {
  identity: '身份标识',
  location: '位置标段',
  measurement: '测量数据',
  workflow: '整改核验',
  media: '影像原件',
  attachmentIndex: '附件索引',
  assurance: '签名审计',
};

export const PURPOSE_LABELS: Record<string, string> = {
  deliver: '正式交付',
  review: '审阅/离线标注',
  audit: '审计查证',
};
