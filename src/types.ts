// ============================================================
// 交付契约平台 · 共享领域类型
// 所有跨层（领域逻辑 / Worker / IndexedDB / UI）结构均定义于此
// ============================================================

export type Role = 'builder' | 'supervisor' | 'auditor' | 'admin';

export type Purpose = 'deliver' | 'review' | 'audit';

/** 字段组：授权交集的“字段组”维度 */
export type FieldGroup =
  | 'identity' // 报告号 / 修订号 / 缺陷ID
  | 'location' // 标段 / 坐标
  | 'measurement' // 裂缝宽度 / 检测方法
  | 'workflow' // 整改状态 / 核验时间
  | 'media' // 影像原件引用
  | 'attachmentIndex' // 经授权的附件索引
  | 'assurance'; // 哈希 / 签名 / 修订链

export type FieldValueType =
  | 'string'
  | 'integer'
  | 'decimal'
  | 'datetime'
  | 'enum'
  | 'coordinate'
  | 'attachmentRefs'
  | 'hash'
  | 'signature';

/** 字段契约：明确类型、单位、舍入精度、空值含义、枚举、来源与可见角色 */
export interface FieldContract {
  key: string;
  label: string;
  group: FieldGroup;
  valueType: FieldValueType;
  unit?: string;
  /** 保留小数位（舍入精度） */
  scale?: number;
  /** 仪器检出限；低于此值必须表达为“<检出限”，严禁舍入成 0 */
  detectionLimit?: number;
  /** 空值的业务含义（null 绝不等于 0 / 未整改） */
  nullMeaning: string;
  required: boolean;
  enumValues?: { value: string; label: string }[];
  /** 数据来源系统 / 责任方 */
  source: string;
  /** 契约层面允许可见的角色（最终还需与授权许可求交集） */
  visibleRoles: Role[];
  description?: string;
}

// ---------------- 源数据 ----------------

export interface Coordinate {
  /** 地方工程坐标系 X（米，源数据保留 3 位小数） */
  x: number;
  y: number;
}

export type RectificationStatus = 'open' | 'in_progress' | 'rectified' | 'verified';

export type DetectionMethod = 'visual' | 'crack_gauge' | 'ultrasonic' | 'ground_penetrating_radar';

export interface Defect {
  defectId: string;
  projectId: string;
  sectionId: string;
  coordinate: Coordinate | null;
  /** 裂缝宽度原始读数（毫米，可能低于检出限；null 表示未测量） */
  crackWidthMm: number | null;
  detectionMethod: DetectionMethod | null;
  imageSummary: string | null;
  rectificationStatus: RectificationStatus | null;
  verifiedAt: string | null;
  attachmentIds: string[];
}

export interface Attachment {
  attachmentId: string;
  projectId: string;
  sectionId: string;
  defectId: string | null;
  filename: string;
  kind: 'photo' | 'reading' | 'certificate' | 'internal';
  contentType: string;
  /** 演示环境中以内联 SVG 文本作为“附件原件” */
  contentText: string;
  sha256: string;
  bytes: number;
  /** 是否可进入监理的授权附件索引 */
  supervisorIndexable: boolean;
}

export interface ReportRevision {
  reportNo: string;
  revision: number;
  projectId: string;
  title: string;
  publishedAt: string;
  /** 本修订相对上一修订的变更说明 */
  changeNote: string;
  /** 本修订发生变化的缺陷字段（用于重审标记与差异展示） */
  changes: { defectId: string; field: string; before: unknown; after: unknown }[];
  defects: Defect[];
  /** 对该修订规范化内容计算出的报告哈希 */
  reportHash: string;
  signedBy: string;
  signature: string;
  signedAt: string;
}

export interface Report {
  reportNo: string;
  projectId: string;
  currentRevision: number;
  revisions: ReportRevision[];
}

export interface Project {
  projectId: string;
  name: string;
  sections: { sectionId: string; name: string }[];
}

export interface Account {
  accountId: string;
  username: string;
  password: string;
  displayName: string;
  role: Role;
  org: string;
  /** 施工方账号所属标段；监理/审计为跨标段授权，用许可表达 */
  sectionIds?: string[];
}

// ---------------- 授权 ----------------

export interface Authorization {
  licenseId: string;
  /** 许可版本：换发/变更字段组时递增，物化包固定此版本 */
  licenseVersion: number;
  accountId: string;
  role: Role;
  projectId: string;
  /** 授权标段；['*'] 表示项目内全部标段 */
  sectionIds: string[];
  fieldGroups: FieldGroup[];
  purposes: Purpose[];
  validFrom: string;
  validUntil: string;
  status: 'active' | 'revoked';
  issuedAt: string;
  revokedAt?: string;
  revokeReason?: string;
}

/** 六维交集的逐维结论 */
export interface AuthDimensionTrace {
  dimension: 'project' | 'section' | 'role' | 'fieldGroup' | 'purpose' | 'validity';
  label: string;
  required: string;
  granted: string;
  passed: boolean;
}

// ---------------- 投影编译器 ----------------

export type DecisionOutcome = 'included' | 'excluded' | 'transformed';

export type ReasonCode =
  | 'included'
  | 'contract_role_denied'
  | 'project_not_authorized'
  | 'section_not_authorized'
  | 'role_license_mismatch'
  | 'field_group_not_licensed'
  | 'purpose_not_licensed'
  | 'license_revoked'
  | 'license_expired'
  | 'license_not_yet_valid'
  | 'below_detection_limit'
  | 'rounded_to_contract_scale'
  | 'coordinate_precision_applied'
  | 'null_meaning_preserved'
  | 'attachment_unauthorized_section'
  | 'attachment_not_in_authorized_index'
  | 'source_revision_pinned';

export interface FieldReason {
  code: ReasonCode;
  message: string;
}

export interface FieldDecision {
  uid: string;
  entityType: 'report' | 'defect' | 'attachment';
  entityId: string;
  fieldKey: string;
  fieldLabel: string;
  outcome: DecisionOutcome;
  reasons: FieldReason[];
}

export interface ProjectedField<T = unknown> {
  value: T;
  /** 展示文本（含单位 / 检出限表达 / 空值语义） */
  display: string;
  unit?: string;
  decision: FieldDecision;
}

export interface ProjectedDefect {
  defectId: string;
  sectionId?: ProjectedField<string>;
  coordinate?: ProjectedField<{ x: string; y: string }>;
  crackWidth?: ProjectedField<string | number | null> & { belowDetectionLimit?: boolean };
  detectionMethod?: ProjectedField<string>;
  imageSummary?: ProjectedField<string>;
  rectificationStatus?: ProjectedField<string>;
  verifiedAt?: ProjectedField<string>;
  attachments?: ProjectedField<ProjectedAttachmentRef[]>;
}

export interface ProjectedAttachmentRef {
  attachmentId: string;
  filename: string;
  kind: Attachment['kind'];
  sha256: string;
  bytes: number;
  indexOnly: boolean;
}

export interface Projection {
  projectionId: string;
  generatedAt: string;
  mode: 'dynamic' | 'materialized';
  projectId: string;
  reportNo: string;
  revision: number;
  receiverAccountId: string;
  receiverRole: Role;
  purpose: Purpose;
  /** 授权快照（固定许可版本）；无有效许可时为 null */
  licenseSnapshot: Pick<
    Authorization,
    'licenseId' | 'licenseVersion' | 'fieldGroups' | 'sectionIds' | 'purposes'
  > | null;
  contractVersion: string;
  sourceReportHash: string;
  reportHeader: Record<string, ProjectedField>;
  defects: ProjectedDefect[];
  attachmentIndex: ProjectedAttachmentRef[];
  assurance?: {
    reportHash: string;
    signature: string;
    signedBy: string;
    signedAt: string;
    revisionChain: { revision: number; reportHash: string; signedAt: string; changeNote: string }[];
  };
  decisions: FieldDecision[];
  authTrace: AuthDimensionTrace[];
  /** 整体拒绝原因（如项目级无授权 / 许可撤销） */
  deniedReason?: FieldReason;
}

// ---------------- 交付包与校验 ----------------

export interface ValidationCheck {
  id: 'required-fields' | 'units' | 'signature' | 'attachment-refs' | 'report-hash' | 'auth-version';
  label: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
}

export interface ValidationReport {
  valid: boolean;
  checks: ValidationCheck[];
  validatedAt: string;
}

export type PackageStatus = 'available' | 'release_blocked' | 'superseded';

export interface PackagePins {
  contractVersion: string;
  licenseId: string;
  licenseVersionAtMaterialize: number;
  reportNo: string;
  revision: number;
  sourceReportHash: string;
}

export interface DeliveryPackage {
  packageId: string;
  kind: 'materialized' | 'dynamic';
  projectId: string;
  reportNo: string;
  revision: number;
  receiverAccountId: string;
  receiverName: string;
  receiverRole: Role;
  purpose: Purpose;
  pins: PackagePins;
  projection: Projection;
  manifest: {
    requiredPaths: string[];
    units: Record<string, string>;
    files: { path: string; sha256: string; bytes: number }[];
  };
  reportHash: string;
  signer: string;
  algorithm: 'HMAC-SHA256-DEMO';
  signature: string;
  status: PackageStatus;
  createdAt: string;
  downloadCount: number;
  lastReleaseAt?: string;
  /** 演示“传输中/存储后被篡改”开关：为 true 时 payload 与签名不一致 */
  tampered: boolean;
  auditEventIds: string[];
}

// ---------------- 回执账 ----------------

export type ReceiptType =
  | 'transmit_received'
  | 'structure_parsed'
  | 'semantic_confirmed'
  | 'questioned'
  | 'corrected';

export interface Receipt {
  receiptId: string;
  /** 同一接收方 + 报告修订构成一本语义账 */
  ledgerKey: string;
  projectId: string;
  reportNo: string;
  revision: number;
  receiverAccountId: string;
  receiverName: string;
  receiverRole: Role;
  type: ReceiptType;
  at: string;
  note?: string;
  packageId?: string;
  /** corrected 类型：指向被更正的旧修订 / 回执 */
  correctsRevision?: number;
  correctsReceiptId?: string;
  /** 传输回执等机器来源标记 */
  source: 'receiver' | 'gateway' | 'platform';
}

export type LedgerState =
  | 'none'
  | 'transmit_received'
  | 'structure_parsed'
  | 'semantic_confirmed'
  | 'questioned'
  | 'conflict'
  | 'adjudicated_confirm'
  | 'adjudicated_question'
  | 'corrected';

export interface Adjudication {
  adjudicationId: string;
  ledgerKey: string;
  at: string;
  adminAccountId: string;
  outcome: 'uphold_confirmation' | 'uphold_question';
  rationale: string;
}

// ---------------- 离线审阅意见 ----------------

export type CommentSyncState = 'local-only' | 'pending' | 'synced' | 'merge-conflict';

export interface ReviewComment {
  /** 意见ID：离线创建即生成，恢复联网后按此 ID 合并 */
  commentId: string;
  projectId: string;
  reportNo: string;
  defectId: string;
  body: string;
  authorAccountId: string;
  authorName: string;
  /** 基线版本：离线意见必须绑定某个报告修订与哈希 */
  baseline: {
    reportNo: string;
    revision: number;
    reportHash: string;
    packageId?: string;
  };
  createdAt: string;
  updatedAt: string;
  syncState: CommentSyncState;
  /** 服务端已存在同 ID 且更新时，保存服务端文本供冲突裁定 */
  serverBody?: string;
  serverUpdatedAt?: string;
  /** 合并后计算：基线之后相关字段发生变化，需对新修订重审 */
  needsReReviewFor?: number;
  changedFields?: string[];
}

export interface ReceiptDraft {
  draftId: string;
  ledgerKey: string;
  projectId: string;
  reportNo: string;
  revision: number;
  receiverAccountId: string;
  type: ReceiptType;
  note?: string;
  createdAt: string;
  syncState: 'local-only' | 'pending';
}

// ---------------- 审计 ----------------

export type AuditEventType =
  | 'package_materialized'
  | 'package_released'
  | 'package_release_blocked'
  | 'package_rebuilt'
  | 'dynamic_projection_generated'
  | 'validation_failed'
  | 'license_revoked'
  | 'license_renewed'
  | 'revision_published'
  | 'comments_merged'
  | 'receipt_registered'
  | 'conflict_adjudicated'
  | 'offline_edit_blocked'
  | 'semantic_gate_hold'
  | 'semantic_gate_passed';

export interface AuditEvent {
  eventId: string;
  at: string;
  type: AuditEventType;
  actorAccountId: string;
  actorName: string;
  summary: string;
  detail?: Record<string, unknown>;
  /** 已签署交付的审计摘要在任何授权变更后都保留 */
  signedDeliverySummary?: {
    packageId: string;
    reportHash: string;
    signature: string;
    receiverAccountId: string;
    revision: number;
  };
}

// ---------------- 持久化根状态 ----------------

export interface ServerState {
  licenses: Authorization[];
  reports: Record<string, Report>; // key reportNo
  currentReportNo: string;
  adjudications: Adjudication[];
  /** 服务端意见（模拟“云端”，同步合并的对端） */
  serverComments: ReviewComment[];
}

export const CONTRACT_VERSION = 'fc-2026.1';

// ============================================================
// 语义行为契约 / 基准样本 / 观测探针 / 差分回放 / 变形测试 / 交付门禁
// 解决“结构签名相同但单位、缺失值或枚举语义被消费方解释错”的问题：
// 结构校验只能证明字段还在，语义门禁证明字段的含义没有被破坏。
// ============================================================

/** 不变量类别：对应题目要求的单位换算 / 空值 / 舍入 / 过滤 / 聚合五类 */
export type InvariantKind = 'unit' | 'null' | 'rounding' | 'filter' | 'aggregation' | 'enum';

/** 空值处理纪律 */
export type NullPolicy =
  | 'preserve_null' // 必须保留 null 的业务含义，禁止替换为 0 / 空串 / 纪元时间 / 默认枚举
  | 'not_applicable'; // 非可空字段

/** 单个字段的机器可执行语义行为契约（由 FIELD_CONTRACTS 派生 + 补充行为不变量） */
export interface SemanticFieldContract {
  fieldKey: string;
  label: string;
  valueType: FieldValueType;
  /** 契约基准单位（如 mm / m）；无单位字段为 undefined */
  canonicalUnit?: string;
  /**
   * 单位换算不变量：消费方若以其他单位接收，必须声明的乘性换算因子。
   * 例：crackWidthMm 以 m 接收时 factor=0.001；探针据此验证“单位缩放后数值不变量”。
   * 无单位字段不声明。
   */
  unitConversions?: { unit: string; factor: number }[];
  scale?: number;
  detectionLimit?: number;
  nullPolicy: NullPolicy;
  /** 枚举合法值域（结构类型 string 但语义只允许其中之一） */
  enumDomain?: string[];
  /** 舍入不变量：投影值小数位不得超过契约 scale，且先判检出限再舍入 */
  roundingInvariant: boolean;
  /** 过滤不变量：未授权实体/字段必须整体缺省，消费方不得用默认值补位 */
  filterInvariant: boolean;
  /** 聚合不变量：参与统计时 null / 低于检出限值不得按 0 计入；描述聚合口径 */
  aggregationRule?: string;
  /** 人类可读的不变量声明（门禁报告直接展示） */
  invariantStatements: { kind: InvariantKind; statement: string }[];
}

/** 受控样本中单条缺陷记录（源单位原始读数，故意覆盖各类语义边界） */
export interface BenchmarkDefect {
  defectId: string;
  sectionId: string;
  coordinate: { x: number; y: number } | null;
  crackWidthMm: number | null;
  detectionMethod: DetectionMethod | null;
  imageSummary: string | null;
  rectificationStatus: RectificationStatus | null;
  verifiedAt: string | null;
  attachmentIds: string[];
  /** 该样本专门覆盖的语义边界标签 */
  semanticTags: string[];
}

/** 单条样本的投影预期（参考实现口径，作为探针比对基准） */
export interface BenchmarkExpectation {
  defectId: string;
  /** 预期该实体是否通过过滤（false 时消费方结果中必须缺省该实体） */
  visible: boolean;
  fields: {
    fieldKey: string;
    /** 预期机器值；null 表示语义空值，字符串 '<LOD' 表示低于检出限 */
    expectedValue: number | string | null | { x: string; y: string };
    expectedDisplay: string;
    expectedUnit?: string;
    /** 预期触发的语义原因码（below_detection_limit / null_meaning_preserved / rounded_to_contract_scale …） */
    expectedReasonCodes: ReasonCode[];
  }[];
  /** 聚合预期：可见且可计入统计的裂缝宽度序列（null 与 <LOD 不得按 0 计入） */
  aggregation: {
    countableWidthsMm: number[];
    expectedCount: number;
    expectedSumMm: number;
    expectedAvgMm: number | null;
  };
}

/** 冻结的受控基准样本集（版本与契约/策略快照绑定） */
export interface SemanticBenchmark {
  benchmarkVersion: string;
  /** 绑定的字段契约版本，版本不一致禁止回放/门禁 */
  contractVersion: string;
  /** 绑定的字段策略快照哈希（六维授权策略 + 字段契约注册表的冻结指纹） */
  policyFingerprint: string;
  createdAt: string;
  /** 样本集规范化内容哈希：样本任何字节变化都会改变，用于冻结校验 */
  benchmarkHash: string;
  defects: BenchmarkDefect[];
  expectations: BenchmarkExpectation[];
}

/** 消费方对单个样本字段的观测结果（探针收集项） */
export interface FieldObservation {
  defectId: string;
  fieldKey: string;
  /** 消费方实际输出；字段被过滤时应缺省（omitted=true） */
  observedValue?: number | string | null | { x: string; y: string };
  observedDisplay?: string;
  observedUnit?: string;
  /** 消费方声明的接收单位（用于单位换算不变量验证），默认契约基准单位 */
  receivedUnit?: string;
  omitted?: boolean;
  /** 消费方自报的处理原因码（可选） */
  reasonCodes?: ReasonCode[];
}

/** 消费方对整个样本集的结果摘要（探针输出） */
export interface ObservationProbe {
  probeId: string;
  consumerId: string;
  consumerName: string;
  /** 回放所针对的样本版本，必须与门禁冻结的 benchmarkVersion 完全一致 */
  benchmarkVersion: string;
  benchmarkHash: string;
  contractVersion: string;
  ranAt: string;
  observations: FieldObservation[];
  /** 消费方自己算出的聚合摘要（用于聚合不变量验证） */
  aggregationSummary?: {
    countedAsZero: string[]; // 被消费方按 0 计入的缺陷ID（null / <LOD 误入即违规）
    sumMm: number;
    count: number;
    avgMm: number | null;
  };
}

/** 单条语义分歧（差异解释器输出，可定位到实体 × 字段 × 不变量） */
export interface SemanticDivergence {
  divergenceId: string;
  kind: InvariantKind;
  defectId: string;
  fieldKey: string;
  severity: 'blocker' | 'major' | 'minor';
  expected: string;
  observed: string;
  explanation: string;
  /** 修复指引 */
  hint: string;
}

/** 探针与投影预期比对后的解释报告 */
export interface ProbeReport {
  probeId: string;
  consumerId: string;
  benchmarkVersion: string;
  matched: boolean;
  totalChecks: number;
  passedChecks: number;
  divergences: SemanticDivergence[];
  /** 冻结绑定校验结论 */
  binding: {
    benchmarkVersionMatch: boolean;
    benchmarkHashMatch: boolean;
    contractVersionMatch: boolean;
    policyFingerprintMatch: boolean;
  };
}

/** 变形测试类别 */
export type MetamorphicTransform = 'unit_scale' | 'equivalent_reorder' | 'missing_injection';

/** 一次变形测试用例及其不变量断言结果 */
export interface MetamorphicCase {
  caseId: string;
  transform: MetamorphicTransform;
  title: string;
  fieldKey: string;
  /** 变形说明（施加了什么等价变换） */
  description: string;
  /** 断言的不变量类别 */
  invariantKind: InvariantKind;
  passed: boolean;
  expected: string;
  observed: string;
  detail: string;
}

export interface MetamorphicSuiteReport {
  suiteId: string;
  benchmarkVersion: string;
  contractVersion: string;
  ranAt: string;
  cases: MetamorphicCase[];
  passed: boolean;
}

/** 差分回放报告：参考实现与消费方处理同一版本样本 */
export interface ReplayReport {
  replayId: string;
  benchmarkVersion: string;
  benchmarkHash: string;
  contractVersion: string;
  consumerId: string;
  ranAt: string;
  /** 参考实现（本平台投影编译器）的探针结果摘要 */
  referenceProbe: ObservationProbe;
  /** 消费方回传的探针结果摘要 */
  consumerProbe: ObservationProbe;
  probeReport: ProbeReport;
  /** 冻结绑定不通过时为 false，且不得给出语义通过结论 */
  bindingValid: boolean;
}

/** 门禁结论 */
export type GateVerdict = 'pass' | 'delivery_hold';

export interface SemanticGateCheck {
  id: 'binding' | 'probe' | 'metamorphic' | 'unit-invariant' | 'null-invariant';
  label: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
}

/** 语义交付门禁报告：结构签名相同但语义不变量被违反时输出 delivery_hold（暂停交付） */
export interface SemanticGateReport {
  reportId: string;
  ranAt: string;
  benchmarkVersion: string;
  benchmarkHash: string;
  contractVersion: string;
  policyFingerprint: string;
  verdict: GateVerdict;
  /** 暂停交付的具体原因（verdict=delivery_hold 时非空） */
  holdReasons: string[];
  checks: SemanticGateCheck[];
  probeReports: ProbeReport[];
  metamorphic: MetamorphicSuiteReport;
  replay?: ReplayReport;
}
