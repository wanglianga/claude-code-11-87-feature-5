import type {
  Account,
  DeliveryPackage,
  Projection,
  Purpose,
  Report,
  ValidationReport,
} from '../types';
import { uid, canonicalStringify, sha256Hex, signPayload } from './hash';
import { validatePackage, type ValidatorContext } from './validator';

// ============================================================
// 交付包构建：固定报告修订 + 许可版本 → 投影 → 清单 → 签名 → 校验
// ============================================================

export interface BuildPackageArgs {
  kind: DeliveryPackage['kind'];
  report: Report;
  projection: Projection;
  account: Account;
  purpose: Purpose;
  licenseId: string;
  licenseVersionAtMaterialize: number;
  sourceReportHash: string;
  atIso: string;
  validatorContext: Omit<ValidatorContext, 'atIso'>;
}

/** 根据投影中实际存在的必需契约字段生成 requiredPaths */
function buildRequiredPaths(projection: Projection): string[] {
  const paths: string[] = [];
  if (projection.reportHeader.reportNo) paths.push('projection.reportHeader.reportNo.value');
  if (projection.reportHeader.revision) paths.push('projection.reportHeader.revision.value');

  projection.defects.forEach((d, i) => {
    paths.push(`projection.defects[${i}].defectId`);
    const map: [keyof typeof d, string][] = [
      ['sectionId', 'sectionId'],
      ['coordinate', 'coordinate'],
      ['crackWidth', 'crackWidthMm'],
      ['detectionMethod', 'detectionMethod'],
      ['imageSummary', 'imageSummary'],
      ['rectificationStatus', 'rectificationStatus'],
      ['verifiedAt', 'verifiedAt'],
    ];
    for (const [prop] of map) {
      if (d[prop]) paths.push(`projection.defects[${i}].${prop}.decision.uid`);
    }
  });
  return paths;
}

export async function buildDeliveryPackage(args: BuildPackageArgs): Promise<{
  pkg: DeliveryPackage;
  validation: ValidationReport;
}> {
  const { projection, account, report, atIso } = args;

  // 清单文件：projection.json + 每个附件引用的哈希条目
  const projectionCanonical = canonicalStringify(projection);
  const files: DeliveryPackage['manifest']['files'] = [
    {
      path: 'projection.json',
      sha256: await sha256Hex(projectionCanonical),
      bytes: new TextEncoder().encode(projectionCanonical).length,
    },
  ];
  const allRefs = [
    ...projection.attachmentIndex,
    ...projection.defects.flatMap((d) => d.attachments?.value ?? []),
  ];
  for (const ref of allRefs) {
    files.push({ path: `attachments/${ref.attachmentId}.ref`, sha256: ref.sha256, bytes: ref.bytes });
  }

  const pkg: DeliveryPackage = {
    packageId: uid('PKG'),
    kind: args.kind,
    projectId: report.projectId,
    reportNo: report.reportNo,
    revision: projection.revision,
    receiverAccountId: account.accountId,
    receiverName: account.displayName,
    receiverRole: account.role,
    purpose: args.purpose,
    pins: {
      contractVersion: projection.contractVersion,
      licenseId: args.licenseId,
      licenseVersionAtMaterialize: args.licenseVersionAtMaterialize,
      reportNo: report.reportNo,
      revision: projection.revision,
      sourceReportHash: args.sourceReportHash,
    },
    projection,
    manifest: {
      requiredPaths: buildRequiredPaths(projection),
      units: { coordinate: 'm', crackWidthMm: 'mm' },
      files,
    },
    reportHash: args.sourceReportHash,
    signer: '江城工程检测有限公司 · 交付签署服务（演示 HMAC 密钥）',
    algorithm: 'HMAC-SHA256-DEMO',
    signature: '',
    status: 'available',
    createdAt: atIso,
    downloadCount: 0,
    tampered: false,
    auditEventIds: [],
  };

  pkg.signature = await signPayload({
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
  });

  const validation = await validatePackage(pkg, { ...args.validatorContext, atIso });
  return { pkg, validation };
}

/** 导出为可下载的 JSON 交付包文件 */
export function serializePackageDownload(pkg: DeliveryPackage): Blob {
  const envelope = {
    format: 'DCP-DELIVERY-PACKAGE/1.0',
    exportedAt: new Date().toISOString(),
    package: pkg,
  };
  return new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
}
