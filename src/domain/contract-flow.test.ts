import { beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, buildSeedServerState, getAttachments, PENDING_R2 } from './seed';
import { compileProjection } from './compiler';
import { findLicense } from './auth';
import { buildDeliveryPackage } from './package';
import { validatePackage } from './validator';
import type { ServerState } from '../types';

const AT = '2026-11-25T10:00:00+08:00';

let server: ServerState;
let attachments = getAttachments();
const attMap = () => new Map(attachments.map((a) => [a.attachmentId, a]));

beforeAll(async () => {
  server = await buildSeedServerState();
  attachments = getAttachments();
});

function compileFor(username: string, projectId = 'P', revision = 1, purpose?: 'deliver' | 'review' | 'audit') {
  const acc = ACCOUNTS.find((a) => a.username === username)!;
  const report = Object.values(server.reports).find((r) => r.projectId === projectId)!;
  const license = findLicense(server.licenses, acc.accountId, projectId);
  return compileProjection({
    report,
    revision,
    account: acc,
    license,
    purpose: purpose ?? (acc.role === 'auditor' ? 'audit' : 'deliver'),
    mode: 'materialized',
    atIso: AT,
    attachmentMap: attMap(),
  });
}

describe('样例：施工方 B1 标段投影', () => {
  it('只能看到 B1 的 3 条缺陷，看不到 B2 的 D-P-003', () => {
    const p = compileFor('builder');
    const ids = p.defects.map((d) => d.defectId).sort();
    expect(ids).toEqual(['D-P-001', 'D-P-002', 'D-P-004']);
    expect(ids).not.toContain('D-P-003');
  });

  it('坐标 0.1m、裂缝宽度 0.1mm、检出限与 null 语义正确', () => {
    const p = compileFor('builder');
    const d1 = p.defects.find((d) => d.defectId === 'D-P-001')!;
    expect(d1.crackWidth?.display).toBe('12.0 mm');
    expect(d1.coordinate?.display).toContain('51230.5');
    expect(d1.coordinate?.display).toContain('38821.7');

    const d2 = p.defects.find((d) => d.defectId === 'D-P-002')!;
    expect(d2.crackWidth?.display).toContain('<0.1');
    expect(d2.crackWidth?.belowDetectionLimit).toBe(true);

    const d4 = p.defects.find((d) => d.defectId === 'D-P-004')!;
    expect(d4.crackWidth?.display).toContain('未测量');
  });

  it('B2 缺陷与照片有明确的 section_not_authorized 原因，A-201 被过滤', () => {
    const p = compileFor('builder');
    const d3 = p.decisions.find((d) => d.entityId === 'D-P-003' && d.fieldKey === 'defectId')!;
    expect(d3.outcome).toBe('excluded');
    expect(d3.reasons.some((r) => r.code === 'section_not_authorized')).toBe(true);

    const a201 = p.decisions.find((d) => d.entityId === 'A-201' && d.fieldKey === 'attachmentIndex')!;
    expect(a201.outcome).toBe('excluded');

    // 自己标段的 A-101 引用应输出
    const d1 = p.defects.find((d) => d.defectId === 'D-P-001')!;
    expect(d1.attachments?.value.map((a) => a.attachmentId)).toContain('A-101');
  });
});

describe('样例：监理仅见授权附件索引', () => {
  it('索引含 A-201（跨标段授权）但排除内部 A-104', () => {
    const p = compileFor('supervisor');
    const ids = p.attachmentIndex.map((a) => a.attachmentId).sort();
    expect(ids).toEqual(['A-101', 'A-102', 'A-103', 'A-201']);
    expect(ids).not.toContain('A-104');

    const a104 = p.decisions.find((d) => d.entityId === 'A-104')!;
    expect(a104.reasons.some((r) => r.code === 'attachment_not_in_authorized_index')).toBe(true);

    // 测量字段组未授权 → 有 field_group_not_licensed 决策
    const width = p.decisions.find((d) => d.fieldKey === 'crackWidthMm')!;
    expect(width.outcome).toBe('excluded');
    expect(width.reasons.some((r) => r.code === 'field_group_not_licensed')).toBe(true);
  });
});

describe('样例：审计员只见签名修订链，且被项目隔离', () => {
  it('P 项目：assurance 可见、缺陷记录为 0（标段交集为空）', () => {
    const p = compileFor('auditor', 'P', 1, 'audit');
    expect(p.assurance).toBeDefined();
    expect(p.assurance?.revisionChain).toHaveLength(1);
    expect(p.defects).toHaveLength(0);
  });

  it('Q 项目：无许可 → project_not_authorized 整体拒绝', () => {
    const p = compileFor('auditor', 'Q', 1, 'audit');
    expect(p.deniedReason?.code).toBe('project_not_authorized');
    expect(p.assurance).toBeUndefined();
    expect(p.defects).toHaveLength(0);
  });
});

describe('授权撤销 / 有效期', () => {
  it('撤销后六维交集在 validity 维失败', () => {
    const acc = ACCOUNTS.find((a) => a.username === 'builder')!;
    const lic = findLicense(server.licenses, acc.accountId, 'P')!;
    const revoked = { ...lic, status: 'revoked' as const };
    const p = compileProjection({
      report: server.reports.R1,
      revision: 1,
      account: acc,
      license: revoked,
      purpose: 'deliver',
      mode: 'dynamic',
      atIso: AT,
      attachmentMap: attMap(),
    });
    expect(p.deniedReason?.code).toBe('license_revoked');
    expect(p.defects).toHaveLength(0);
  });

  it('过期许可返回 license_expired', () => {
    const acc = ACCOUNTS.find((a) => a.username === 'builder')!;
    const lic = findLicense(server.licenses, acc.accountId, 'P')!;
    const expired = { ...lic, validUntil: '2026-01-31T23:59:59+08:00' };
    const p = compileProjection({
      report: server.reports.R1,
      revision: 1,
      account: acc,
      license: expired,
      purpose: 'deliver',
      mode: 'dynamic',
      atIso: AT,
      attachmentMap: attMap(),
    });
    expect(p.deniedReason?.code).toBe('license_expired');
  });
});

describe('交付包构建与校验器', () => {
  it('合法物化包六项检查全部通过', async () => {
    const acc = ACCOUNTS.find((a) => a.username === 'builder')!;
    const license = findLicense(server.licenses, acc.accountId, 'P')!;
    const report = server.reports.R1;
    const rev = report.revisions[0];
    const projection = compileProjection({
      report, revision: 1, account: acc, license, purpose: 'deliver',
      mode: 'materialized', atIso: AT, attachmentMap: attMap(),
    });
    const { pkg, validation } = await buildDeliveryPackage({
      kind: 'materialized', report, projection, account: acc, purpose: 'deliver',
      licenseId: license.licenseId, licenseVersionAtMaterialize: 1,
      sourceReportHash: rev.reportHash, atIso: AT,
      validatorContext: { revision: rev, attachments, currentLicense: license },
    });
    expect(pkg.signature).toHaveLength(64);
    expect(validation.valid).toBe(true);
    expect(validation.checks.every((c) => c.status !== 'fail')).toBe(true);
  });

  it('篡改投影内容后签名检查失败', async () => {
    const acc = ACCOUNTS.find((a) => a.username === 'builder')!;
    const license = findLicense(server.licenses, acc.accountId, 'P')!;
    const report = server.reports.R1;
    const rev = report.revisions[0];
    const projection = compileProjection({
      report, revision: 1, account: acc, license, purpose: 'deliver',
      mode: 'materialized', atIso: AT, attachmentMap: attMap(),
    });
    const { pkg } = await buildDeliveryPackage({
      kind: 'materialized', report, projection, account: acc, purpose: 'deliver',
      licenseId: license.licenseId, licenseVersionAtMaterialize: 1,
      sourceReportHash: rev.reportHash, atIso: AT,
      validatorContext: { revision: rev, attachments },
    });
    pkg.projection.defects[0].crackWidth!.display = '999.9 mm（篡改）';
    const v = await validatePackage(pkg, { revision: rev, attachments, atIso: AT });
    const sig = v.checks.find((c) => c.id === 'signature')!;
    expect(sig.status).toBe('fail');
    expect(v.valid).toBe(false);
  });
});

describe('修订2 种子', () => {
  it('PENDING_R2 将 D-P-001 改为 15.0 投影值', () => {
    expect(PENDING_R2).not.toBeNull();
    const change = PENDING_R2!.changes.find((c) => c.field === 'crackWidthMm')!;
    expect(change.before).toBe(12.0);
    expect(change.after).toBe(15.0);
  });
});
