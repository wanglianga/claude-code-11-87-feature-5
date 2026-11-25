import type {
  Attachment,
  Authorization,
  DeliveryPackage,
  ReportRevision,
  ValidationCheck,
  ValidationReport,
} from '../types';
import { canonicalStringify, sha256Canonical, verifyPayloadSignature } from './hash';
import { getContract } from './contracts';
import { recheckForRelease } from './auth';

// ============================================================
// 交付包校验器（可在 WebWorker 中运行）
// 检查：必需字段 / 单位 / 签名 / 附件引用 / 报告哈希 / 授权版本
// ============================================================

/** 签名覆盖的规范化信封（运行时状态字段不参与签名） */
export function packageSigningPayload(pkg: DeliveryPackage): unknown {
  return {
    packageId: pkg.packageId,
    kind: pkg.kind,
    projectId: pkg.projectId,
    reportNo: pkg.reportNo,
    revision: pkg.revision,
    receiverAccountId: pkg.receiverAccountId,
    purpose: pkg.purpose,
    pins: pkg.pins,
    projection: pkg.projection,
    manifest: pkg.manifest,
    reportHash: pkg.reportHash,
    signer: pkg.signer,
    algorithm: pkg.algorithm,
    createdAt: pkg.createdAt,
  };
}

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    // 支持 a[0].b 形式
    const m = /^([^[]*)((?:\[\d+\])*)$/.exec(key);
    if (!m) return (acc as Record<string, unknown>)[key];
    let cur: unknown = m[1] ? (acc as Record<string, unknown>)[m[1]] : acc;
    const idxs = m[2].match(/\d+/g) ?? [];
    for (const i of idxs) cur = (cur as unknown[] | undefined)?.[Number(i)];
    return cur;
  }, obj);
}

/** 从修订源数据重算报告哈希（与 seed 的哈希口径一致） */
export async function computeRevisionSourceHash(rev: ReportRevision): Promise<string> {
  return sha256Canonical({
    reportNo: rev.reportNo,
    revision: rev.revision,
    projectId: rev.projectId,
    defects: rev.defects,
  });
}

export interface ValidatorContext {
  revision: ReportRevision;
  attachments: Attachment[];
  atIso: string;
  /** 动态校验/释放前复核时传入当前许可；物化时可省略（由释放闸门另行复核） */
  currentLicense?: Authorization | null;
}

export async function validatePackage(
  pkg: DeliveryPackage,
  ctx: ValidatorContext,
): Promise<ValidationReport> {
  const checks: ValidationCheck[] = [];
  const attachmentMap = new Map(ctx.attachments.map((a) => [a.attachmentId, a]));

  // 1) 必需字段 -------------------------------------------------
  const missing: string[] = [];
  for (const p of pkg.manifest.requiredPaths) {
    const v = getPath(pkg, p);
    if (v === undefined || v === null || v === '') missing.push(p);
  }
  // 独立硬规则：每个投影缺陷必须有缺陷ID（意见/回执关联锚点）
  pkg.projection.defects.forEach((d, i) => {
    if (!d.defectId) missing.push(`projection.defects[${i}].defectId`);
  });
  checks.push({
    id: 'required-fields',
    label: '必需字段完整性',
    status: missing.length === 0 ? 'pass' : 'fail',
    detail:
      missing.length === 0
        ? `${pkg.manifest.requiredPaths.length} 个必需路径均存在，缺陷ID锚点完整。`
        : `缺失 ${missing.length} 项：${missing.slice(0, 6).join('、')}${missing.length > 6 ? ' …' : ''}`,
  });

  // 2) 单位契约 -------------------------------------------------
  const unitProblems: string[] = [];
  for (const [fieldKey, unit] of Object.entries(pkg.manifest.units)) {
    const expected = getContract(fieldKey).unit;
    if (expected !== unit) unitProblems.push(`${fieldKey} 包内单位=${unit}，契约单位=${expected}`);
  }
  pkg.projection.defects.forEach((d) => {
    if (d.crackWidth?.unit && d.crackWidth.unit !== getContract('crackWidthMm').unit) {
      unitProblems.push(`${d.defectId} 裂缝宽度单位不是 mm`);
    }
    if (d.coordinate?.unit && d.coordinate.unit !== getContract('coordinate').unit) {
      unitProblems.push(`${d.defectId} 坐标单位不是 m`);
    }
  });
  checks.push({
    id: 'units',
    label: '单位与字段契约一致',
    status: unitProblems.length === 0 ? 'pass' : 'fail',
    detail: unitProblems.length === 0 ? 'mm / m 等单位标注与契约完全一致。' : unitProblems.join('；'),
  });

  // 3) 签名 -----------------------------------------------------
  const sigOk = await verifyPayloadSignature(packageSigningPayload(pkg), pkg.signature);
  checks.push({
    id: 'signature',
    label: '数字签名有效',
    status: sigOk ? 'pass' : 'fail',
    detail: sigOk
      ? `签名验证通过（${pkg.algorithm}，签署方：${pkg.signer}）。`
      : '签名验证失败：包内容在签署后被改动，或签名系伪造。',
  });

  // 4) 附件引用 -------------------------------------------------
  const refProblems: string[] = [];
  const allRefs = [
    ...pkg.projection.attachmentIndex,
    ...pkg.projection.defects.flatMap((d) => d.attachments?.value ?? []),
  ];
  for (const ref of allRefs) {
    const src = attachmentMap.get(ref.attachmentId);
    if (!src) {
      refProblems.push(`${ref.attachmentId} 为悬空引用`);
      continue;
    }
    if (src.sha256 !== ref.sha256) {
      refProblems.push(`${ref.attachmentId} 哈希与附件库不一致`);
    }
    const fileEntry = pkg.manifest.files.find((f) => f.path.endsWith(`${ref.attachmentId}.ref`) || f.sha256 === ref.sha256);
    if (!fileEntry) refProblems.push(`${ref.attachmentId} 未在包文件清单中登记哈希`);
  }
  checks.push({
    id: 'attachment-refs',
    label: '附件引用与哈希',
    status: refProblems.length === 0 ? 'pass' : 'fail',
    detail:
      refProblems.length === 0
        ? `${allRefs.length} 条附件引用均可解析，SHA-256 与附件库、包清单一致。`
        : refProblems.join('；'),
  });

  // 5) 报告哈希（来源版本一致性） -------------------------------
  const recomputed = await computeRevisionSourceHash(ctx.revision);
  const hashProblems: string[] = [];
  if (recomputed !== ctx.revision.reportHash) hashProblems.push('源修订内容与其报告哈希不符（源数据被改动）');
  if (pkg.reportHash !== ctx.revision.reportHash) hashProblems.push('包报告哈希 ≠ 当前修订库哈希');
  if (pkg.pins.sourceReportHash !== ctx.revision.reportHash) hashProblems.push('固定(pin)的来源哈希与修订库不一致');
  checks.push({
    id: 'report-hash',
    label: '报告哈希/来源版本',
    status: hashProblems.length === 0 ? 'pass' : 'fail',
    detail:
      hashProblems.length === 0
        ? `来源版本一致：${ctx.revision.reportHash.slice(0, 20)}…（${pkg.reportNo} 修订${pkg.revision}）。`
        : hashProblems.join('；'),
  });

  // 6) 授权版本（若提供当前许可） -------------------------------
  if (ctx.currentLicense === undefined) {
    checks.push({
      id: 'auth-version',
      label: '授权版本复核',
      status: 'warn',
      detail: '离线校验未连接当前许可库；实际释放/下载时必须通过释放闸门实时复核授权版本。',
    });
  } else if (ctx.currentLicense === null) {
    checks.push({
      id: 'auth-version',
      label: '授权版本复核',
      status: 'fail',
      detail: '当前已不存在覆盖该项目的许可，禁止释放。',
    });
  } else {
    const recheck = recheckForRelease({
      license: ctx.currentLicense,
      pinnedLicenseId: pkg.pins.licenseId,
      pinnedLicenseVersion: pkg.pins.licenseVersionAtMaterialize,
      atIso: ctx.atIso,
    });
    checks.push({
      id: 'auth-version',
      label: '授权版本复核',
      status: recheck.allowed ? 'pass' : 'fail',
      detail: recheck.message,
    });
  }

  const valid = checks.every((c) => c.status !== 'fail');
  return { valid, checks, validatedAt: ctx.atIso };
}

/** 供 Worker / 下载使用：包的规范化字节长度 */
export function packageArtifactBytes(pkg: DeliveryPackage): number {
  return new TextEncoder().encode(canonicalStringify(packageSigningPayload(pkg))).length;
}
