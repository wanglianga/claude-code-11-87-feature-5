import type {
  Account,
  AuthDimensionTrace,
  Authorization,
  FieldGroup,
  Purpose,
  ReasonCode,
  Role,
} from '../types';

// ============================================================
// 授权引擎：项目 ∩ 施工标段 ∩ 接收角色 ∩ 字段组 ∩ 用途 ∩ 有效期
// 任何一维不通过，对应字段即被过滤；编译器保留逐维原因。
// ============================================================

export function findLicense(
  licenses: Authorization[],
  accountId: string,
  projectId: string,
): Authorization | null {
  const matches = licenses.filter((l) => l.accountId === accountId && l.projectId === projectId);
  if (matches.length === 0) return null;
  // 同一账号/项目存在多版许可时，取版本最高的一条作为当前许可
  return matches.reduce((a, b) => (b.licenseVersion > a.licenseVersion ? b : a));
}

export type ValidityState = 'active' | 'revoked' | 'expired' | 'not_yet_valid';

export function validityState(lic: Authorization, atIso: string): ValidityState {
  if (lic.status === 'revoked') return 'revoked';
  const t = new Date(atIso).getTime();
  if (t < new Date(lic.validFrom).getTime()) return 'not_yet_valid';
  if (t > new Date(lic.validUntil).getTime()) return 'expired';
  return 'active';
}

function validityFailureCode(state: ValidityState): ReasonCode {
  switch (state) {
    case 'revoked':
      return 'license_revoked';
    case 'expired':
      return 'license_expired';
    case 'not_yet_valid':
      return 'license_not_yet_valid';
    default:
      return 'included';
  }
}

export interface AccessArgs {
  license: Authorization | null;
  account: Account;
  projectId: string;
  purpose: Purpose;
  group: FieldGroup;
  /** 实体所属标段；报告级字段不传，表示项目级字段 */
  sectionId?: string;
  atIso: string;
}

export interface AccessEvaluation {
  allowed: boolean;
  traces: AuthDimensionTrace[];
  /** 未通过维度对应的原因码（全部列出） */
  failureCodes: ReasonCode[];
}

/** 判断某账号对某“字段 × 实体上下文”的六维交集结果 */
export function evaluateFieldAccess(args: AccessArgs): AccessEvaluation {
  const { license, account, projectId, purpose, group, sectionId, atIso } = args;
  const traces: AuthDimensionTrace[] = [];
  const failureCodes: ReasonCode[] = [];

  // 1) 项目
  const projectPass = !!license && license.projectId === projectId;
  traces.push({
    dimension: 'project',
    label: '项目',
    required: projectId,
    granted: license?.projectId ?? '无许可',
    passed: projectPass,
  });
  if (!projectPass) failureCodes.push('project_not_authorized');

  // 2) 施工标段（仅对标段实体强制；项目级字段标注为项目级求值）
  let sectionPass = true;
  let sectionRequired = '项目级字段（不按标段过滤）';
  let sectionGranted = license ? license.sectionIds.join(',') || '空（无标段）' : '无许可';
  if (sectionId !== undefined) {
    sectionRequired = sectionId;
    sectionPass =
      !!license &&
      (license.sectionIds.includes('*') || license.sectionIds.includes(sectionId as string));
    sectionGranted = license ? license.sectionIds.join(',') || '空（无标段）' : '无许可';
    traces.push({
      dimension: 'section',
      label: '施工标段',
      required: sectionRequired,
      granted: sectionGranted,
      passed: sectionPass,
    });
    if (!sectionPass) failureCodes.push('section_not_authorized');
  } else {
    traces.push({
      dimension: 'section',
      label: '施工标段',
      required: sectionRequired,
      granted: sectionGranted,
      passed: true,
    });
  }

  // 3) 接收角色（许可签发给的角色必须与当前接收角色一致）
  const rolePass = !!license && (license.role as Role) === account.role;
  traces.push({
    dimension: 'role',
    label: '接收角色',
    required: account.role,
    granted: license?.role ?? '无许可',
    passed: rolePass,
  });
  if (!rolePass) failureCodes.push('role_license_mismatch');

  // 4) 字段组
  const groupPass = !!license && license.fieldGroups.includes(group);
  traces.push({
    dimension: 'fieldGroup',
    label: '字段组',
    required: group,
    granted: license ? license.fieldGroups.join(',') : '无许可',
    passed: groupPass,
  });
  if (!groupPass) failureCodes.push('field_group_not_licensed');

  // 5) 用途
  const purposePass = !!license && license.purposes.includes(purpose);
  traces.push({
    dimension: 'purpose',
    label: '用途',
    required: purpose,
    granted: license ? license.purposes.join(',') : '无许可',
    passed: purposePass,
  });
  if (!purposePass) failureCodes.push('purpose_not_licensed');

  // 6) 有效期（含撤销）
  const vState = license ? validityState(license, atIso) : ('revoked' as ValidityState);
  const validityPass = vState === 'active';
  traces.push({
    dimension: 'validity',
    label: '有效期/许可状态',
    required: '在有效期内且未撤销',
    granted: license ? validityLabel(vState) : '无许可',
    passed: validityPass,
  });
  if (!validityPass) failureCodes.push(validityFailureCode(vState));

  return { allowed: failureCodes.length === 0, traces, failureCodes };
}

export function validityLabel(s: ValidityState): string {
  switch (s) {
    case 'active':
      return '有效';
    case 'revoked':
      return '已撤销';
    case 'expired':
      return '已过期';
    case 'not_yet_valid':
      return '尚未生效';
  }
}

/** 释放/新请求前的“当前授权版本”复核结论 */
export interface ReleaseAuthCheck {
  allowed: boolean;
  code?: ReasonCode | 'license_version_stale';
  message: string;
  currentLicenseVersion?: number;
}

export function recheckForRelease(args: {
  license: Authorization | null;
  pinnedLicenseId: string;
  pinnedLicenseVersion: number;
  atIso: string;
}): ReleaseAuthCheck {
  const { license, pinnedLicenseId, pinnedLicenseVersion, atIso } = args;
  if (!license || license.licenseId !== pinnedLicenseId) {
    return { allowed: false, code: 'project_not_authorized', message: '固定的授权许可已不存在，禁止释放旧包。' };
  }
  const v = validityState(license, atIso);
  if (v === 'revoked') {
    return {
      allowed: false,
      code: 'license_revoked',
      message: `许可 ${license.licenseId} 已撤销${license.revokeReason ? `（${license.revokeReason}）` : ''}，旧包停止新下载。`,
      currentLicenseVersion: license.licenseVersion,
    };
  }
  if (v === 'expired' || v === 'not_yet_valid') {
    return { allowed: false, code: validityFailureCode(v), message: `许可当前状态：${validityLabel(v)}，禁止释放。` };
  }
  if (license.licenseVersion !== pinnedLicenseVersion) {
    return {
      allowed: false,
      code: 'license_version_stale',
      message: `物化时固定许可版本 v${pinnedLicenseVersion}，当前已为 v${license.licenseVersion}，需按新授权重建交付包。`,
      currentLicenseVersion: license.licenseVersion,
    };
  }
  return { allowed: true, message: `授权复核通过（${license.licenseId} v${license.licenseVersion}）。` };
}
