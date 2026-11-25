import { CONTRACT_VERSION } from '../types';
import type {
  Account,
  Attachment,
  Authorization,
  FieldDecision,
  FieldReason,
  Projection,
  ProjectedAttachmentRef,
  ProjectedDefect,
  ProjectedField,
  Purpose,
  ReasonCode,
  Report,
} from '../types';
import { getContract } from './contracts';
import { evaluateFieldAccess } from './auth';
import { enumLabel, formatCoordinate, formatDateTime, formatMeasure } from './format';
import { uid } from './hash';

export const REASON_TEXT: Record<ReasonCode, string> = {
  included: '六维交集与字段契约均通过，按契约输出',
  contract_role_denied: '字段契约的可见角色清单不含当前接收角色',
  project_not_authorized: '授权许可未覆盖该项目（项目维拒绝）',
  section_not_authorized: '实体所属施工标段不在授权标段范围内（标段维拒绝）',
  role_license_mismatch: '许可签发角色与接收方当前角色不一致（角色维拒绝）',
  field_group_not_licensed: '许可字段组不含该字段所属字段组（字段组维拒绝）',
  purpose_not_licensed: '许可用途不含本次请求用途（用途维拒绝）',
  license_revoked: '授权许可已撤销，有效期维不通过',
  license_expired: '授权许可已超过有效期',
  license_not_yet_valid: '授权许可尚未到生效时间',
  below_detection_limit: '原始读数低于仪器检出限，按契约输出“<检出限”，不得舍入为 0',
  rounded_to_contract_scale: '已按字段契约的舍入精度投影',
  coordinate_precision_applied: '坐标已按契约降级/舍入到 0.1 m 交付精度',
  null_meaning_preserved: '保留 null 的业务含义，未用 0、空串或纪元时间替代',
  attachment_unauthorized_section: '附件所属标段未授权，该引用已从投影中过滤',
  attachment_not_in_authorized_index: '附件未通过“授权附件索引”可见性检查，不进入索引',
  source_revision_pinned: '投影固定到指定报告修订及其来源哈希，不随最新修订漂移',
};

export function reason(code: ReasonCode, extra?: string): FieldReason {
  return { code, message: extra ? `${REASON_TEXT[code]}：${extra}` : REASON_TEXT[code] };
}

export interface CompileInput {
  report: Report;
  revision: number;
  account: Account;
  license: Authorization | null;
  purpose: Purpose;
  mode: Projection['mode'];
  atIso: string;
  attachmentMap: Map<string, Attachment>;
  /** 动态模式下为当前实时许可版本；物化模式下为固定快照说明 */
  pinnedLicenseVersion?: number;
}

interface ConsiderArgs {
  entityType: FieldDecision['entityType'];
  entityId: string;
  fieldKey: string;
  sectionId?: string;
}

class CompilerSession {
  decisions: FieldDecision[] = [];
  constructor(private readonly input: CompileInput) {}

  /** 求值某字段的契约角色 + 六维交集，并登记一条字段决策 */
  consider(args: ConsiderArgs): { allowed: boolean; decision: FieldDecision } {
    const contract = getContract(args.fieldKey);
    const evaluation = evaluateFieldAccess({
      license: this.input.license,
      account: this.input.account,
      projectId: this.input.report.projectId,
      purpose: this.input.purpose,
      group: contract.group,
      sectionId: args.sectionId,
      atIso: this.input.atIso,
    });

    const reasons: FieldReason[] = [];
    let allowed = evaluation.allowed;

    if (!contract.visibleRoles.includes(this.input.account.role)) {
      allowed = false;
      reasons.push(reason('contract_role_denied'));
    }
    for (const code of evaluation.failureCodes) reasons.push(reason(code));
    if (allowed) reasons.push(reason('included'));

    const decision: FieldDecision = {
      uid: `${args.entityType}:${args.entityId}:${args.fieldKey}`,
      entityType: args.entityType,
      entityId: args.entityId,
      fieldKey: args.fieldKey,
      fieldLabel: contract.label,
      outcome: allowed ? 'included' : 'excluded',
      reasons,
    };
    this.decisions.push(decision);
    return { allowed, decision };
  }

  /** 标段级可见性：以 defectId 字段为锚 */
  defectInScope(defectId: string, sectionId: string): boolean {
    const { allowed } = this.consider({
      entityType: 'defect',
      entityId: defectId,
      fieldKey: 'defectId',
      sectionId,
    });
    return allowed;
  }

  field<T>(
    args: ConsiderArgs,
    build: () => { value: T; display: string; unit?: string; extraReasons?: FieldReason[]; transformed?: boolean },
  ): ProjectedField<T> | undefined {
    const { allowed, decision } = this.consider(args);
    if (!allowed) return undefined;
    const built = build();
    if (built.extraReasons?.length) {
      decision.reasons = [...decision.reasons.filter((x) => x.code === 'included'), ...built.extraReasons];
      decision.outcome = built.transformed ? 'transformed' : 'included';
    }
    // 保留 build() 返回的扩展字段（如 belowDetectionLimit）
    const { extraReasons: _er, transformed: _t, ...rest } = built;
    return { ...rest, decision } as ProjectedField<T>;
  }
}

export function compileProjection(input: CompileInput): Projection {
  const session = new CompilerSession(input);
  const { report, account, license, purpose, atIso } = input;
  const rev = report.revisions.find((x) => x.revision === input.revision);
  if (!rev) throw new Error(`报告 ${report.reportNo} 不存在修订 ${input.revision}`);

  // 以 reportNo 锚点字段的求值轨迹作为“六维交集”展示样本
  const anchorEval = evaluateFieldAccess({
    license,
    account,
    projectId: report.projectId,
    purpose,
    group: getContract('reportNo').group,
    atIso,
  });

  const reportHeader: Record<string, ProjectedField> = {};

  const reportNoField = session.field(
    { entityType: 'report', entityId: `${report.reportNo}#r${rev.revision}`, fieldKey: 'reportNo' },
    () => ({ value: report.reportNo, display: report.reportNo }),
  );
  if (reportNoField) reportHeader.reportNo = reportNoField;

  const revisionField = session.field(
    { entityType: 'report', entityId: `${report.reportNo}#r${rev.revision}`, fieldKey: 'revision' },
    () => ({ value: rev.revision, display: `修订 ${rev.revision}` }),
  );
  if (revisionField) reportHeader.revision = revisionField;

  // 锚点被整体拒绝时给出顶层原因
  let deniedReason: FieldReason | undefined;
  if (!reportNoField) {
    const code = anchorEval.failureCodes[0] ?? 'contract_role_denied';
    deniedReason = reason(code);
  }

  // ---------------- 缺陷逐条投影 ----------------
  const defects: ProjectedDefect[] = [];
  const reportAttachmentIds = new Set(rev.defects.flatMap((d) => d.attachmentIds));

  for (const d of rev.defects) {
    // defectId 决策已在 defectInScope 中登记
    const inScope = session.defectInScope(d.defectId, d.sectionId);
    if (!inScope) {
      // 标段不可见：仍对其余字段登记过滤原因，保证“字段级原因”完整
      registerDeniedDefectFields(session, d.defectId, d.sectionId);
      continue;
    }

    const pd: ProjectedDefect = { defectId: d.defectId };

    const section = session.field(
      { entityType: 'defect', entityId: d.defectId, fieldKey: 'sectionId', sectionId: d.sectionId },
      () => ({ value: d.sectionId, display: enumLabel('sectionId', d.sectionId) }),
    );
    if (section) pd.sectionId = section as ProjectedDefect['sectionId'];

    const coord = session.field(
      { entityType: 'defect', entityId: d.defectId, fieldKey: 'coordinate', sectionId: d.sectionId },
      () => {
        if (d.coordinate === null) {
          return {
            value: null,
            display: '未采集坐标（null，非原点）',
            extraReasons: [reason('null_meaning_preserved')],
            transformed: true,
          };
        }
        const f = formatCoordinate(d.coordinate)!;
        return {
          value: { x: f.x, y: f.y },
          display: f.display,
          unit: 'm',
          extraReasons: [
            reason(
              'coordinate_precision_applied',
              `源 (${d.coordinate!.x}, ${d.coordinate!.y}) m → 交付 ${f.x}, ${f.y}（0.1 m）`,
            ),
          ],
          transformed: true,
        };
      },
    );
    if (coord) pd.coordinate = coord as ProjectedDefect['coordinate'];

    const crack = session.field(
      { entityType: 'defect', entityId: d.defectId, fieldKey: 'crackWidthMm', sectionId: d.sectionId },
      () => {
        const m = formatMeasure('crackWidthMm', d.crackWidthMm);
        if (d.crackWidthMm === null) {
          return {
            value: null,
            display: m.display,
            unit: 'mm',
            extraReasons: [reason('null_meaning_preserved')],
            transformed: true,
          };
        }
        if (m.belowDetectionLimit) {
          return {
            value: m.display,
            display: m.display,
            unit: 'mm',
            belowDetectionLimit: true,
            extraReasons: [reason('below_detection_limit', `原始读数 ${d.crackWidthMm} mm < 检出限 0.1 mm`)],
            transformed: true,
          } as never;
        }
        return {
          value: m.value,
          display: m.display,
          unit: 'mm',
          extraReasons: [
            reason('rounded_to_contract_scale', `原始读数 ${d.crackWidthMm} mm → 契约精度 0.1 mm：${m.display}`),
          ],
          transformed: true,
        };
      },
    );
    if (crack) pd.crackWidth = crack as ProjectedDefect['crackWidth'];

    const method = session.field(
      { entityType: 'defect', entityId: d.defectId, fieldKey: 'detectionMethod', sectionId: d.sectionId },
      () => ({ value: d.detectionMethod ?? '', display: enumLabel('detectionMethod', d.detectionMethod) }),
    );
    if (method) pd.detectionMethod = method as ProjectedDefect['detectionMethod'];

    const summary = session.field(
      { entityType: 'defect', entityId: d.defectId, fieldKey: 'imageSummary', sectionId: d.sectionId },
      () =>
        d.imageSummary === null
          ? {
              value: null,
              display: '无影像摘要（null，不代表影像正常）',
              extraReasons: [reason('null_meaning_preserved')],
              transformed: true,
            }
          : { value: d.imageSummary, display: d.imageSummary },
    );
    if (summary) pd.imageSummary = summary as ProjectedDefect['imageSummary'];

    const status = session.field(
      {
        entityType: 'defect',
        entityId: d.defectId,
        fieldKey: 'rectificationStatus',
        sectionId: d.sectionId,
      },
      () => ({
        value: d.rectificationStatus ?? '',
        display: enumLabel('rectificationStatus', d.rectificationStatus),
        ...(d.rectificationStatus === null
          ? { extraReasons: [reason('null_meaning_preserved')], transformed: true }
          : {}),
      }),
    );
    if (status) pd.rectificationStatus = status as ProjectedDefect['rectificationStatus'];

    const verified = session.field(
      { entityType: 'defect', entityId: d.defectId, fieldKey: 'verifiedAt', sectionId: d.sectionId },
      () => ({
        value: d.verifiedAt ?? '',
        display: formatDateTime(d.verifiedAt),
        ...(d.verifiedAt === null
          ? { extraReasons: [reason('null_meaning_preserved')], transformed: true }
          : {}),
      }),
    );
    if (verified) pd.verifiedAt = verified as ProjectedDefect['verifiedAt'];

    // 影像原件引用（media 组），逐附件再做标段交集
    const attachmentsField = session.field(
      { entityType: 'defect', entityId: d.defectId, fieldKey: 'attachments', sectionId: d.sectionId },
      () => {
        const refs: ProjectedAttachmentRef[] = [];
        for (const attId of d.attachmentIds) {
          const att = input.attachmentMap.get(attId);
          if (!att) {
            refs.push({
              attachmentId: attId,
              filename: `[缺失引用] ${attId}`,
              kind: 'internal',
              sha256: '',
              bytes: 0,
              indexOnly: false,
            });
            continue;
          }
          const secEval = evaluateFieldAccess({
            license,
            account,
            projectId: report.projectId,
            purpose,
            group: 'media',
            sectionId: att.sectionId,
            atIso,
          });
          if (!secEval.allowed) {
            session.decisions.push({
              uid: `attachment:${attId}:reference`,
              entityType: 'attachment',
              entityId: attId,
              fieldKey: 'reference',
              fieldLabel: `影像引用 ${att.filename}`,
              outcome: 'excluded',
              reasons: [
                reason('attachment_unauthorized_section', `附件标段 ${att.sectionId}`),
                ...secEval.failureCodes.map((c) => reason(c)),
              ],
            });
            continue;
          }
          refs.push({
            attachmentId: att.attachmentId,
            filename: att.filename,
            kind: att.kind,
            sha256: att.sha256,
            bytes: att.bytes,
            indexOnly: false,
          });
        }
        return { value: refs, display: `${refs.length} 个授权附件引用` };
      },
    );
    if (attachmentsField) pd.attachments = attachmentsField as ProjectedDefect['attachments'];

    defects.push(pd);
  }

  // ---------------- 授权附件索引（attachmentIndex 组） ----------------
  const attachmentIndex: ProjectedAttachmentRef[] = [];
  for (const attId of reportAttachmentIds) {
    const att = input.attachmentMap.get(attId);
    if (!att || att.projectId !== report.projectId) continue;

    const { allowed } = session.consider({
      entityType: 'attachment',
      entityId: attId,
      fieldKey: 'attachmentIndex',
      sectionId: att.sectionId,
    });
    if (!allowed) continue;

    if (!att.supervisorIndexable) {
      const existing = session.decisions.find((x) => x.uid === `attachment:${attId}:attachmentIndex`);
      if (existing) {
        existing.outcome = 'excluded';
        existing.reasons = [reason('attachment_not_in_authorized_index', att.filename)];
      }
      continue;
    }
    attachmentIndex.push({
      attachmentId: att.attachmentId,
      filename: att.filename,
      kind: att.kind,
      sha256: att.sha256,
      bytes: att.bytes,
      indexOnly: true,
    });
  }

  // ---------------- 签名 / 哈希 / 修订链（assurance 组） ----------------
  let assurance: Projection['assurance'];
  const hashField = session.field(
    {
      entityType: 'report',
      entityId: `${report.reportNo}#r${rev.revision}`,
      fieldKey: 'reportHash',
    },
    () => ({ value: rev.reportHash, display: rev.reportHash }),
  );
  const sigField = session.field(
    {
      entityType: 'report',
      entityId: `${report.reportNo}#r${rev.revision}`,
      fieldKey: 'signature',
    },
    () => ({ value: rev.signature, display: `HMAC-SHA256:${rev.signature.slice(0, 24)}…` }),
  );
  const chainAllowed = session.consider({
    entityType: 'report',
    entityId: report.reportNo,
    fieldKey: 'revisionChain',
  }).allowed;

  if (hashField && sigField && chainAllowed) {
    assurance = {
      reportHash: rev.reportHash,
      signature: rev.signature,
      signedBy: rev.signedBy,
      signedAt: rev.signedAt,
      revisionChain: report.revisions.map((x) => ({
        revision: x.revision,
        reportHash: x.reportHash,
        signedAt: x.signedAt,
        changeNote: x.changeNote,
      })),
    };
  }

  return {
    projectionId: uid('proj'),
    generatedAt: atIso,
    mode: input.mode,
    projectId: report.projectId,
    reportNo: report.reportNo,
    revision: rev.revision,
    receiverAccountId: account.accountId,
    receiverRole: account.role,
    purpose,
    licenseSnapshot: license
      ? {
          licenseId: license.licenseId,
          licenseVersion: input.pinnedLicenseVersion ?? license.licenseVersion,
          fieldGroups: license.fieldGroups,
          sectionIds: license.sectionIds,
          purposes: license.purposes,
        }
      : null,
    contractVersion: CONTRACT_VERSION,
    sourceReportHash: rev.reportHash,
    reportHeader,
    defects,
    attachmentIndex,
    assurance,
    decisions: session.decisions,
    authTrace: anchorEval.traces,
    deniedReason,
  };
}

/** 标段不可见时，对该缺陷的其余契约字段补齐排除决策 */
function registerDeniedDefectFields(session: CompilerSession, defectId: string, sectionId: string) {
  const rest = [
    'sectionId',
    'coordinate',
    'crackWidthMm',
    'detectionMethod',
    'imageSummary',
    'rectificationStatus',
    'verifiedAt',
    'attachments',
  ];
  for (const fieldKey of rest) {
    session.consider({ entityType: 'defect', entityId: defectId, fieldKey, sectionId });
  }
}
