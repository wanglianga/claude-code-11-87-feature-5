import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  Account,
  Adjudication,
  Attachment,
  AuditEvent,
  Authorization,
  DeliveryPackage,
  Purpose,
  Receipt,
  ReceiptDraft,
  ReceiptType,
  ReviewComment,
  SemanticGateReport,
  ServerState,
} from '../types';
import { ACCOUNTS, buildSeedServerState, getAttachments, PENDING_R2 } from '../domain/seed';
import { compileProjection } from '../domain/compiler';
import { buildDeliveryPackage } from '../domain/package';
import { findLicense, recheckForRelease } from '../domain/auth';
import { ledgerKeyOf } from '../domain/receipts';
import { mergeOfflineComments, resolveCommentConflict } from '../domain/merge';
import { applyReReviewFlag } from '../domain/merge';
import { uid } from '../domain/hash';
import { buildSemanticBenchmark } from '../domain/semantic/benchmark';
import { runSemanticGate } from '../domain/semantic/gate';
import { SIMULATED_CONSUMERS, getConsumerDef } from '../domain/semantic/consumers';
import { workerApi } from './workerClient';
import { idbBulkPut, idbDelete, idbGetAll, idbPut, kvGet, kvSet, STORES, wipeAll } from '../db/idb';

export type TabKey = 'scenario' | 'studio' | 'packages' | 'review' | 'receipts' | 'history' | 'contracts' | 'semantic';

interface Notice {
  kind: 'ok' | 'err' | 'info';
  text: string;
}

interface StoreState {
  booted: boolean;
  online: boolean;
  sessionAccountId: string | null;
  tab: TabKey;
  server: ServerState | null;
  attachments: Attachment[];
  localComments: ReviewComment[];
  drafts: ReceiptDraft[];
  receipts: Receipt[];
  packages: DeliveryPackage[];
  audit: AuditEvent[];
  notice: Notice | null;
  /** 最近一次语义交付门禁报告（持久化；delivery_hold 时释放闸门强制拦截） */
  semanticGate: SemanticGateReport | null;
}

export interface MaterializeResult {
  ok: boolean;
  message: string;
  pkg?: DeliveryPackage;
}

interface StoreValue extends StoreState {
  account: Account | null;
  setTab: (t: TabKey) => void;
  notify: (kind: Notice['kind'], text: string) => void;
  login: (username: string, password: string) => Account | null;
  quickSwitch: (accountId: string) => void;
  logout: () => void;
  setOnline: (v: boolean) => void;
  resetDemo: () => Promise<void>;

  licenseFor: (accountId: string, projectId: string) => Authorization | null;
  revokeLicense: (licenseId: string, reason: string) => Promise<void>;
  renewLicense: (licenseId: string) => Promise<void>;
  publishRevision2: () => Promise<void>;

  materializePackage: (receiverAccountId: string, revision: number, purpose: Purpose) => Promise<MaterializeResult>;
  releasePackage: (packageId: string) => Promise<MaterializeResult>;
  rebuildPackage: (packageId: string) => Promise<MaterializeResult>;
  revalidatePackage: (packageId: string) => Promise<import('../types').ValidationReport>;
  tamperPackage: (packageId: string) => Promise<void>;

  /** 运行语义交付门禁：对模拟消费方执行冻结绑定校验 + 差分回放 + 变形测试 */
  runSemanticGate: (consumerIds?: string[]) => Promise<SemanticGateReport>;

  saveComment: (
    input: { commentId?: string; defectId: string; body: string; baseline: ReviewComment['baseline'] },
    opts?: { offline?: boolean },
  ) => Promise<ReviewComment | null>;
  syncComments: () => Promise<{ merged: number; conflicts: number }>;
  resolveConflict: (commentId: string, choose: 'local' | 'server') => Promise<void>;
  reportBlockedSignedEdit: (packageId: string) => Promise<void>;

  saveDraft: (d: Omit<ReceiptDraft, 'draftId' | 'createdAt' | 'syncState' | 'ledgerKey'> & { draftId?: string }) => Promise<void>;
  deleteDraft: (draftId: string) => Promise<void>;
  submitDraft: (draftId: string) => Promise<Receipt | null>;
  addReceipt: (r: {
    receiverAccountId: string;
    reportNo: string;
    revision: number;
    type: ReceiptType;
    note?: string;
    packageId?: string;
  }) => Promise<Receipt>;
  adjudicate: (ledgerKey: string, outcome: Adjudication['outcome'], rationale: string) => Promise<void>;
}

const StoreContext = createContext<StoreValue | null>(null);

function nowIso(): string {
  return new Date().toISOString();
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StoreState>({
    booted: false,
    online: true,
    sessionAccountId: null,
    tab: 'scenario',
    server: null,
    attachments: [],
    localComments: [],
    drafts: [],
    receipts: [],
    packages: [],
    audit: [],
    notice: null,
    semanticGate: null,
  });

  // 始终保存最新在线状态，避免“同一事件中先 setOnline 再调用动作”读到旧闭包
  const onlineRef = useRef(state.online);
  onlineRef.current = state.online;

  // ---------------- 启动：IndexedDB → 种子 ----------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let server = await kvGet<ServerState>('server');
      let attachments = await kvGet<Attachment[]>('attachments');
      if (!server || !attachments || attachments.length === 0) {
        server = await buildSeedServerState();
        attachments = getAttachments();
        await kvSet('server', server);
        await kvSet('attachments', attachments);
      }

      let [localComments, drafts, receipts, packages, audit] = await Promise.all([
        idbGetAll<ReviewComment>(STORES.localComments),
        idbGetAll<ReceiptDraft>(STORES.drafts),
        idbGetAll<Receipt>(STORES.receipts),
        idbGetAll<DeliveryPackage>(STORES.packages),
        idbGetAll<AuditEvent>(STORES.audit),
      ]);
      audit = audit.sort((a, b) => +new Date(b.at) - +new Date(a.at));
      const semanticGate = await kvGet<SemanticGateReport>('semanticGate');

      // 首次运行：预物化三个角色的 R1 修订1 签名交付包
      if (packages.length === 0) {
        const seeded = await seedInitialPackages(server, attachments);
        packages = seeded.packages;
        audit = [...seeded.events, ...audit].sort((a, b) => +new Date(b.at) - +new Date(a.at));
        await idbBulkPut(STORES.packages, packages);
        await idbBulkPut(STORES.audit, seeded.events);
      }

      const sessionAccountId = await kvGet<string>('session');
      if (cancelled) return;
      setState((s) => ({
        ...s,
        booted: true,
        server: server!,
        attachments: attachments!,
        localComments,
        drafts,
        receipts,
        packages,
        audit,
        semanticGate: semanticGate ?? null,
        sessionAccountId: sessionAccountId ?? null,
      }));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const notify = useCallback((kind: Notice['kind'], text: string) => {
    setState((s) => ({ ...s, notice: { kind, text } }));
    window.setTimeout(() => {
      setState((s) => (s.notice?.text === text ? { ...s, notice: null } : s));
    }, 4200);
  }, []);

  const setTab = useCallback((tab: TabKey) => setState((s) => ({ ...s, tab })), []);

  // ---------------- 审计 ----------------
  const pushAudit = useCallback(
    async (e: Omit<AuditEvent, 'eventId' | 'at'> & { at?: string }): Promise<AuditEvent> => {
      const ev: AuditEvent = { ...e, eventId: uid('AUD'), at: e.at ?? nowIso() };
      await idbPut(STORES.audit, ev);
      setState((s) => ({ ...s, audit: [ev, ...s.audit] }));
      return ev;
    },
    [],
  );

  const saveServer = useCallback(async (server: ServerState) => {
    await kvSet('server', server);
    setState((s) => ({ ...s, server }));
  }, []);

  // ---------------- 会话 ----------------
  const account = useMemo(
    () => ACCOUNTS.find((a) => a.accountId === state.sessionAccountId) ?? null,
    [state.sessionAccountId],
  );

  const login = useCallback((username: string, password: string) => {
    const found = ACCOUNTS.find((a) => a.username === username.trim() && a.password === password);
    if (!found) return null;
    setState((s) => ({ ...s, sessionAccountId: found.accountId }));
    void kvSet('session', found.accountId);
    return found;
  }, []);

  const logout = useCallback(() => {
    setState((s) => ({ ...s, sessionAccountId: null }));
    void kvSet('session', null);
  }, []);

  // 演示环境快速切换测试身份（免密），便于在接收方/管理员视角间走查
  const quickSwitch = useCallback((accountId: string) => {
    setState((s) => ({ ...s, sessionAccountId: accountId }));
    void kvSet('session', accountId);
  }, []);

  const setOnline = useCallback((v: boolean) => setState((s) => ({ ...s, online: v })), []);

  const resetDemo = useCallback(async () => {
    await wipeAll();
    window.location.reload();
  }, []);

  const licenseFor = useCallback(
    (accountId: string, projectId: string) => {
      if (!state.server) return null;
      return findLicense(state.server.licenses, accountId, projectId);
    },
    [state.server],
  );

  // ---------------- 授权管理 ----------------
  const revokeLicense = useCallback(
    async (licenseId: string, reason: string) => {
      if (!state.server) return;
      const at = nowIso();
      const licenses = state.server.licenses.map((l) =>
        l.licenseId === licenseId ? { ...l, status: 'revoked' as const, revokedAt: at, revokeReason: reason } : l,
      );
      await saveServer({ ...state.server, licenses });
      const lic = licenses.find((l) => l.licenseId === licenseId);
      await pushAudit({
        type: 'license_revoked',
        actorAccountId: account?.accountId ?? 'u-admin',
        actorName: account?.displayName ?? '平台交付管理员',
        summary: `许可 ${licenseId} 已撤销：${reason}。旧物化包将在新请求/释放时被拦截。`,
        detail: { licenseId, reason, licenseVersion: lic?.licenseVersion },
      });
      notify('info', `许可 ${licenseId} 已撤销，旧包停止新下载。`);
    },
    [state.server, account, saveServer, pushAudit, notify],
  );

  const renewLicense = useCallback(
    async (licenseId: string) => {
      if (!state.server) return;
      const licenses = state.server.licenses.map((l) =>
        l.licenseId === licenseId
          ? { ...l, licenseVersion: l.licenseVersion + 1, status: 'active' as const, revokedAt: undefined, revokeReason: undefined }
          : l,
      );
      await saveServer({ ...state.server, licenses });
      const lic = licenses.find((l) => l.licenseId === licenseId);
      await pushAudit({
        type: 'license_renewed',
        actorAccountId: account?.accountId ?? 'u-admin',
        actorName: account?.displayName ?? '平台交付管理员',
        summary: `许可 ${licenseId} 换发至 v${lic?.licenseVersion}；固定旧版本的物化包需重建。`,
      });
      notify('ok', `许可已换发：当前版本 v${lic?.licenseVersion}`);
    },
    [state.server, account, saveServer, pushAudit, notify],
  );

  // ---------------- 发布修订2 + 旧修订“被更正”账 ----------------
  const publishRevision2 = useCallback(async () => {
    if (!state.server || !PENDING_R2) return;
    const report = state.server.reports.R1;
    if (report.revisions.some((r) => r.revision === 2)) {
      notify('info', '修订2 已发布，无需重复操作。');
      return;
    }
    const at = nowIso();
    const updated: ServerState = {
      ...state.server,
      reports: {
        ...state.server.reports,
        R1: { ...report, currentRevision: 2, revisions: [...report.revisions, PENDING_R2] },
      },
    };
    await saveServer(updated);
    await pushAudit({
      type: 'revision_published',
      actorAccountId: account?.accountId ?? 'u-admin',
      actorName: account?.displayName ?? '平台交付管理员',
      summary: 'R1 修订2 已签署发布：D-P-001 裂缝宽度 12.0 mm → 15.0 mm。修订1 签名与哈希保留。',
      detail: { changes: PENDING_R2.changes, r1Hash: report.revisions[0].reportHash, r2Hash: PENDING_R2.reportHash },
    });

    // 向所有已接收 R1/r1 的接收方补一本“被更正”平台账
    const receiverIds = new Set(
      state.packages.filter((p) => p.reportNo === 'R1' && p.revision === 1).map((p) => p.receiverAccountId),
    );
    const markers: Receipt[] = [];
    for (const rid of receiverIds) {
      const acc = ACCOUNTS.find((a) => a.accountId === rid);
      const receipt: Receipt = {
        receiptId: uid('RCP'),
        ledgerKey: ledgerKeyOf(rid, 'R1', 1),
        projectId: 'P',
        reportNo: 'R1',
        revision: 1,
        receiverAccountId: rid,
        receiverName: acc?.displayName ?? rid,
        receiverRole: acc?.role ?? 'builder',
        type: 'corrected',
        at,
        source: 'platform',
        correctsRevision: 1,
        note: '修订2 已发布并更正 D-P-001 裂缝宽度（12.0→15.0 mm）。修订1 历史签署保留，但不得作为修订2 的语义确认。',
      };
      markers.push(receipt);
      await idbPut(STORES.receipts, receipt);
    }
    setState((s) => ({ ...s, receipts: [...markers, ...s.receipts] }));
    notify('ok', '修订2 已发布；修订1 账上已登记“被更正”。');
  }, [state.server, state.packages, account, saveServer, pushAudit, notify]);

  // ---------------- 物化包 ----------------
  const materializePackage = useCallback(
    async (receiverAccountId: string, revision: number, purpose: Purpose) => {
      if (!state.server) return { ok: false, message: '状态未就绪' };
      const acc = ACCOUNTS.find((a) => a.accountId === receiverAccountId);
      if (!acc) return { ok: false, message: '接收账号不存在' };
      const reportNo = state.server.currentReportNo;
      const report = state.server.reports[reportNo];
      const rev = report.revisions.find((r) => r.revision === revision);
      if (!rev) return { ok: false, message: `修订 ${revision} 不存在` };
      const license = findLicense(state.server.licenses, acc.accountId, report.projectId);
      const at = nowIso();

      // 生成时复核授权版本
      const gate = recheckForRelease({
        license,
        pinnedLicenseId: license?.licenseId ?? '__none__',
        pinnedLicenseVersion: license?.licenseVersion ?? 0,
        atIso: at,
      });
      if (!license || !gate.allowed) {
        await pushAudit({
          type: 'package_release_blocked',
          actorAccountId: account?.accountId ?? 'u-admin',
          actorName: account?.displayName ?? '平台交付管理员',
          summary: `为 ${acc.displayName} 物化 ${reportNo} r${revision} 时授权复核未通过：${gate.message}`,
        });
        return { ok: false, message: gate.message };
      }

      const attachmentMap = new Map(state.attachments.map((a) => [a.attachmentId, a]));
      const projection = await workerApi.compile({
        report,
        revision,
        account: acc,
        license,
        purpose,
        mode: 'materialized',
        atIso: at,
        attachmentMap,
      });

      const { pkg, validation } = await workerApi.buildPackage({
        kind: 'materialized',
        report,
        projection,
        account: acc,
        purpose,
        licenseId: license.licenseId,
        licenseVersionAtMaterialize: license.licenseVersion,
        sourceReportHash: rev.reportHash,
        atIso: at,
        validatorContext: { revision: rev, attachments: state.attachments, currentLicense: license },
      });

      if (!validation.valid) {
        await pushAudit({
          type: 'validation_failed',
          actorAccountId: acc.accountId,
          actorName: acc.displayName,
          summary: `物化包 ${pkg.packageId} 未通过包校验，已拒绝入库。`,
          detail: { checks: validation.checks },
        });
        return { ok: false, message: '包校验未通过，详见校验报告。', pkg };
      }

      await idbPut(STORES.packages, pkg);
      setState((s) => ({ ...s, packages: [pkg, ...s.packages] }));
      const ev = await pushAudit({
        type: 'package_materialized',
        actorAccountId: account?.accountId ?? acc.accountId,
        actorName: account?.displayName ?? '平台交付管理员',
        summary: `已物化并签署 ${acc.role} 包 ${pkg.packageId}（${reportNo} r${revision}，固定 ${license.licenseId} v${license.licenseVersion}）。`,
        signedDeliverySummary: {
          packageId: pkg.packageId,
          reportHash: pkg.reportHash,
          signature: pkg.signature,
          receiverAccountId: acc.accountId,
          revision,
        },
      });
      pkg.auditEventIds.push(ev.eventId);
      await idbPut(STORES.packages, pkg);
      return { ok: true, message: '签名交付包已物化。', pkg };
    },
    [state.server, state.attachments, account, pushAudit],
  );

  // ---------------- 释放 / 下载闸门 ----------------
  const releasePackage = useCallback(
    async (packageId: string): Promise<MaterializeResult> => {
      if (!state.server) return { ok: false, message: '状态未就绪' };
      const pkg = state.packages.find((p) => p.packageId === packageId);
      if (!pkg) return { ok: false, message: '包不存在' };
      const at = nowIso();
      const report = state.server.reports[pkg.reportNo];

      // 拦截规则1：报告已修订 → 旧包停止新下载，要求重建
      const revisionBlocked = report.currentRevision > pkg.revision;
      const revisionMessage = revisionBlocked
        ? `报告已修订至 r${report.currentRevision}，旧 r${pkg.revision} 包不得作为新修订的确认，须重建。`
        : '';

      // 拦截规则2：当前授权实时复核（撤销 / 版本漂移），与修订检查并列执行
      const pinnedLicense = state.server.licenses.find((l) => l.licenseId === pkg.pins.licenseId) ?? null;
      const gate = recheckForRelease({
        license: pinnedLicense,
        pinnedLicenseId: pkg.pins.licenseId,
        pinnedLicenseVersion: pkg.pins.licenseVersionAtMaterialize,
        atIso: at,
      });

      if (revisionBlocked || !gate.allowed) {
        const message = [revisionMessage, gate.allowed ? '' : gate.message].filter(Boolean).join(' ');
        pkg.status = revisionBlocked ? 'superseded' : 'release_blocked';
        await idbPut(STORES.packages, pkg);
        setState((s) => ({ ...s, packages: s.packages.map((p) => (p.packageId === pkg.packageId ? { ...pkg } : p)) }));
        await pushAudit({
          type: 'package_release_blocked',
          actorAccountId: account?.accountId ?? pkg.receiverAccountId,
          actorName: account?.displayName ?? pkg.receiverName,
          summary: `包 ${pkg.packageId} 释放被拦截：${message}`,
          signedDeliverySummary: {
            packageId: pkg.packageId,
            reportHash: pkg.reportHash,
            signature: pkg.signature,
            receiverAccountId: pkg.receiverAccountId,
            revision: pkg.revision,
          },
        });
        return { ok: false, message };
      }

      // 拦截规则3（语义门禁）：结构签名相同但输出违反单位/空值等不变量时，暂停交付
      const semanticHold = state.semanticGate?.verdict === 'delivery_hold';
      if (semanticHold) {
        const message =
          '语义交付门禁处于“暂停交付”：存在消费方在同一版本冻结样本上违反单位/空值/枚举/过滤/聚合不变量（结构签名可能完全相同）。须修复语义分歧并重跑门禁通过后方可释放。';
        pkg.status = 'release_blocked';
        await idbPut(STORES.packages, pkg);
        setState((s) => ({ ...s, packages: s.packages.map((p) => (p.packageId === pkg.packageId ? { ...pkg } : p)) }));
        await pushAudit({
          type: 'package_release_blocked',
          actorAccountId: account?.accountId ?? pkg.receiverAccountId,
          actorName: account?.displayName ?? pkg.receiverName,
          summary: `包 ${pkg.packageId} 释放被语义门禁拦截：${state.semanticGate?.holdReasons.length ?? 0} 项语义不变量问题。`,
          detail: { semanticGateReportId: state.semanticGate?.reportId, holdReasons: state.semanticGate?.holdReasons },
          signedDeliverySummary: {
            packageId: pkg.packageId,
            reportHash: pkg.reportHash,
            signature: pkg.signature,
            receiverAccountId: pkg.receiverAccountId,
            revision: pkg.revision,
          },
        });
        return { ok: false, message };
      }

      // 规则3：完整性实时校验（签名/哈希/附件）
      const rev = report.revisions.find((r) => r.revision === pkg.revision)!;
      const validation = await workerApi.validate(pkg, {
        revision: rev,
        attachments: state.attachments,
        atIso: at,
        currentLicense: pinnedLicense,
      });
      if (!validation.valid) {
        await pushAudit({
          type: 'validation_failed',
          actorAccountId: account?.accountId ?? pkg.receiverAccountId,
          actorName: account?.displayName ?? pkg.receiverName,
          summary: `包 ${pkg.packageId} 释放前校验失败，已拒绝下载。`,
          detail: { checks: validation.checks },
        });
        return { ok: false, message: '释放前校验未通过（签名/哈希/附件），详见校验面板。' };
      }

      pkg.downloadCount += 1;
      pkg.lastReleaseAt = at;
      pkg.status = 'available';
      await idbPut(STORES.packages, pkg);
      setState((s) => ({ ...s, packages: s.packages.map((p) => (p.packageId === pkg.packageId ? { ...pkg } : p)) }));
      await pushAudit({
        type: 'package_released',
        actorAccountId: account?.accountId ?? pkg.receiverAccountId,
        actorName: account?.displayName ?? pkg.receiverName,
        summary: `包 ${pkg.packageId} 通过授权与完整性复核，第 ${pkg.downloadCount} 次释放下载。`,
        signedDeliverySummary: {
          packageId: pkg.packageId,
          reportHash: pkg.reportHash,
          signature: pkg.signature,
          receiverAccountId: pkg.receiverAccountId,
          revision: pkg.revision,
        },
      });
      return { ok: true, message: `已释放（第 ${pkg.downloadCount} 次交付）。`, pkg };
    },
    [state.server, state.packages, state.attachments, state.semanticGate, account, pushAudit],
  );

  const rebuildPackage = useCallback(
    async (packageId: string): Promise<MaterializeResult> => {
      const old = state.packages.find((p) => p.packageId === packageId);
      if (!old || !state.server) return { ok: false, message: '旧包不存在' };
      const report = state.server.reports[old.reportNo];
      const targetRevision = report.currentRevision;
      const result = await materializePackage(old.receiverAccountId, targetRevision, old.purpose);
      if (result.ok && result.pkg) {
        await pushAudit({
          type: 'package_rebuilt',
          actorAccountId: account?.accountId ?? 'u-admin',
          actorName: account?.displayName ?? '平台交付管理员',
          summary: `依据旧包 ${old.packageId} 的接收方/用途，按当前授权重建为 ${result.pkg.packageId}（r${targetRevision}）。旧包审计摘要继续保留。`,
          detail: { oldPackageId: old.packageId, newPackageId: result.pkg.packageId },
        });
      }
      return result;
    },
    [state.packages, state.server, materializePackage, account, pushAudit],
  );

  const revalidatePackage = useCallback(
    async (packageId: string) => {
      const pkg = state.packages.find((p) => p.packageId === packageId)!;
      const report = state.server!.reports[pkg.reportNo];
      const rev = report.revisions.find((r) => r.revision === pkg.revision)!;
      const pinnedLicense = state.server!.licenses.find((l) => l.licenseId === pkg.pins.licenseId) ?? null;
      const validation = await workerApi.validate(pkg, {
        revision: rev,
        attachments: state.attachments,
        atIso: nowIso(),
        currentLicense: pinnedLicense,
      });
      if (!validation.valid) {
        await pushAudit({
          type: 'validation_failed',
          actorAccountId: account?.accountId ?? 'u-admin',
          actorName: account?.displayName ?? '平台交付管理员',
          summary: `手动复核包 ${pkg.packageId} 时发现校验失败项。`,
          detail: { checks: validation.checks },
        });
      }
      return validation;
    },
    [state.packages, state.server, state.attachments, account, pushAudit],
  );

  const tamperPackage = useCallback(
    async (packageId: string) => {
      const pkg = state.packages.find((p) => p.packageId === packageId);
      if (!pkg) return;
      // 演示“签署后内容被篡改”：改动投影中的展示值，签名必然失配
      const firstDefect = pkg.projection.defects.find((d) => d.crackWidth);
      if (firstDefect?.crackWidth) {
        firstDefect.crackWidth = {
          ...firstDefect.crackWidth,
          display: `${firstDefect.crackWidth.display}【传输中被篡改】`,
        };
      } else if (pkg.projection.assurance) {
        pkg.projection.assurance = { ...pkg.projection.assurance, reportHash: '0'.repeat(64) };
      }
      pkg.tampered = true;
      await idbPut(STORES.packages, pkg);
      setState((s) => ({ ...s, packages: s.packages.map((p) => (p.packageId === pkg.packageId ? { ...pkg } : p)) }));
      notify('info', '已模拟篡改包内容，请重新校验以查看签名失败。');
    },
    [state.packages, notify],
  );

  // ---------------- 语义交付门禁 ----------------
  const runSemanticGateAction = useCallback(
    async (consumerIds?: string[]): Promise<SemanticGateReport> => {
      const at = nowIso();
      const benchmark = await buildSemanticBenchmark();
      const ids = consumerIds && consumerIds.length > 0 ? consumerIds : SIMULATED_CONSUMERS.map((c) => c.id);
      const consumers = ids.map((id) => getConsumerDef(id).profile);
      const report = await runSemanticGate({ benchmark, consumers, atIso: at });
      await kvSet('semanticGate', report);
      setState((s) => ({ ...s, semanticGate: report }));
      await pushAudit({
        type: report.verdict === 'pass' ? 'semantic_gate_passed' : 'semantic_gate_hold',
        actorAccountId: account?.accountId ?? 'u-admin',
        actorName: account?.displayName ?? '平台交付管理员',
        summary:
          report.verdict === 'pass'
            ? `语义交付门禁通过：样本 ${report.benchmarkVersion} 冻结绑定一致，${consumers.length} 个消费方差分回放与变形测试全部满足不变量。`
            : `语义交付门禁暂停交付：${report.holdReasons.length} 项语义问题（结构签名可能完全相同，但单位/空值/枚举/过滤/聚合不变量被违反）。`,
        detail: {
          benchmarkVersion: report.benchmarkVersion,
          benchmarkHash: report.benchmarkHash,
          verdict: report.verdict,
          holdReasons: report.holdReasons,
          consumers: ids,
        },
      });
      if (report.verdict === 'delivery_hold') {
        notify('err', '语义门禁：暂停交付。请按差异解释修复消费方语义后重跑门禁。');
      } else {
        notify('ok', '语义门禁通过：消费语义符合契约，可正常交付。');
      }
      return report;
    },
    [account, pushAudit, notify],
  );

  // ---------------- 离线意见 ----------------
  const performSync = useCallback(
    async (listToSync: ReviewComment[]) => {
      if (!state.server) return { merged: 0, conflicts: 0 };
      const report = state.server.reports.R1;
      const at = nowIso();
      const outcome = mergeOfflineComments({
        localComments: listToSync,
        serverComments: state.server.serverComments,
        report,
        atIso: at,
      });
      await saveServer({ ...state.server, serverComments: outcome.serverComments });

      const updatedLocal = state.localComments.map((lc) => {
        const item = outcome.items.find((i) => i.commentId === lc.commentId);
        return item ? item.comment : applyReReviewFlag(lc, report);
      });
      // 新插入的意见也可能不在旧 state.localComments 映射结果中（实际上都在 listToSync）
      for (const item of outcome.items) {
        if (!updatedLocal.some((c) => c.commentId === item.commentId)) updatedLocal.push(item.comment);
      }
      setState((s) => ({ ...s, localComments: updatedLocal }));
      await idbBulkPut(STORES.localComments, updatedLocal);

      const conflicts = outcome.items.filter((i) => i.action === 'conflict').length;
      await pushAudit({
        type: 'comments_merged',
        actorAccountId: account?.accountId ?? 'u-builder',
        actorName: account?.displayName ?? '施工方',
        summary: `按意见ID合并 ${outcome.items.length} 条离线意见（新增 ${
          outcome.items.filter((i) => i.action === 'inserted').length
        } 条），冲突 ${conflicts} 条；重审标记已按最新修订计算。`,
        detail: { items: outcome.items.map((i) => ({ id: i.commentId, action: i.action })) },
      });
      return { merged: outcome.items.length, conflicts };
    },
    [state.server, state.localComments, saveServer, pushAudit, account],
  );

  const saveComment = useCallback(
    async (
      input: { commentId?: string; defectId: string; body: string; baseline: ReviewComment['baseline'] },
      opts?: { offline?: boolean },
    ) => {
      if (!account) {
        notify('err', '请先以接收方账号登录。');
        return null;
      }
      if (!input.body.trim()) {
        notify('err', '意见内容不能为空。');
        return null;
      }
      // 显式 offline 优先（供“一键切离线并写入”这类同事件复合动作）
      const isOnline = opts?.offline === true ? false : onlineRef.current;
      const at = nowIso();
      const existing = input.commentId
        ? state.localComments.find((c) => c.commentId === input.commentId)
        : undefined;
      const comment: ReviewComment = existing
        ? {
            ...existing,
            body: input.body,
            updatedAt: at,
            // 离线时仅落本地；联网时标记 pending 并立即合并
            syncState: isOnline ? 'pending' : 'local-only',
          }
        : {
            commentId: input.commentId ?? uid('CMT'),
            projectId: 'P',
            reportNo: input.baseline.reportNo,
            defectId: input.defectId,
            body: input.body.trim(),
            authorAccountId: account.accountId,
            authorName: account.displayName,
            baseline: input.baseline,
            createdAt: at,
            updatedAt: at,
            syncState: isOnline ? 'pending' : 'local-only',
          };

      await idbPut(STORES.localComments, comment);
      const nextList = [comment, ...state.localComments.filter((c) => c.commentId !== comment.commentId)];
      setState((s) => ({ ...s, localComments: nextList }));

      if (isOnline) {
        await performSync(nextList);
      } else {
        notify('ok', '意见已加密保存在离线工作区（IndexedDB），恢复联网后按意见ID合并。');
      }
      return comment;
    },
    [account, state.localComments, notify, performSync],
  );

  const syncComments = useCallback(async () => {
    if (!onlineRef.current) {
      notify('err', '当前仍处于离线模式，无法同步。');
      return { merged: 0, conflicts: 0 };
    }
    const pending = state.localComments;
    if (pending.length === 0) {
      notify('info', '没有待同步的意见。');
      return { merged: 0, conflicts: 0 };
    }
    const result = await performSync(pending);
    if (result.conflicts > 0) notify('err', `同步完成，但有 ${result.conflicts} 条同ID冲突待裁定。`);
    else notify('ok', `同步完成：合并 ${result.merged} 条意见。`);
    return result;
  }, [state.online, state.localComments, performSync, notify]);

  const resolveConflict = useCallback(
    async (commentId: string, choose: 'local' | 'server') => {
      const c = state.localComments.find((x) => x.commentId === commentId);
      if (!c) return;
      const resolved = resolveCommentConflict(c, choose, nowIso());
      await idbPut(STORES.localComments, resolved);
      let nextLocal = state.localComments.map((x) => (x.commentId === commentId ? resolved : x));
      setState((s) => ({ ...s, localComments: nextLocal }));
      if (choose === 'server' || resolved.syncState === 'pending') {
        // 采用服务端：直接标记 synced 即可；采用本地：再跑一次合并
        if (choose === 'server') {
          const synced = { ...resolved, syncState: 'synced' as const };
          await idbPut(STORES.localComments, synced);
          nextLocal = nextLocal.map((x) => (x.commentId === commentId ? synced : x));
          setState((s) => ({ ...s, localComments: nextLocal }));
        } else {
          await performSync(nextLocal);
        }
      }
      notify('ok', choose === 'server' ? '已采用服务端版本。' : '已采用本地版本并重新合并。');
    },
    [state.localComments, performSync, notify],
  );

  const reportBlockedSignedEdit = useCallback(
    async (packageId: string) => {
      await pushAudit({
        type: 'offline_edit_blocked',
        actorAccountId: account?.accountId ?? 'u-builder',
        actorName: account?.displayName ?? '施工方',
        summary: `离线工作区尝试改写已签名交付包 ${packageId}，已拒绝：签名交付本身不可离线改写，离线仅允许基线审阅意见与回执草案。`,
        detail: { packageId },
      });
      notify('err', '已签名交付包不可离线改写；该尝试已记入审计。');
    },
    [account, pushAudit, notify],
  );

  // ---------------- 回执草案 / 回执 ----------------
  const saveDraft = useCallback(
    async (d: Omit<ReceiptDraft, 'draftId' | 'createdAt' | 'syncState' | 'ledgerKey'> & { draftId?: string }) => {
      const at = nowIso();
      const ledgerKey = ledgerKeyOf(d.receiverAccountId, d.reportNo, d.revision);
      const draft: ReceiptDraft = {
        ...d,
        ledgerKey,
        draftId: d.draftId ?? uid('DRF'),
        createdAt: at,
        syncState: 'local-only',
      };
      await idbPut(STORES.drafts, draft);
      setState((s) => ({
        ...s,
        drafts: d.draftId ? s.drafts.map((x) => (x.draftId === draft.draftId ? draft : x)) : [draft, ...s.drafts],
      }));
      notify('ok', '回执草案已保存在离线工作区，联网后才可提交入账。');
    },
    [notify],
  );

  const deleteDraft = useCallback(async (draftId: string) => {
    await idbDelete(STORES.drafts, draftId);
    setState((s) => ({ ...s, drafts: s.drafts.filter((d) => d.draftId !== draftId) }));
  }, []);

  const addReceipt = useCallback(
    async (r: {
      receiverAccountId: string;
      reportNo: string;
      revision: number;
      type: ReceiptType;
      note?: string;
      packageId?: string;
    }): Promise<Receipt> => {
      const acc = ACCOUNTS.find((a) => a.accountId === r.receiverAccountId);
      const receipt: Receipt = {
        receiptId: uid('RCP'),
        ledgerKey: ledgerKeyOf(r.receiverAccountId, r.reportNo, r.revision),
        projectId: 'P',
        reportNo: r.reportNo,
        revision: r.revision,
        receiverAccountId: r.receiverAccountId,
        receiverName: acc?.displayName ?? r.receiverAccountId,
        receiverRole: acc?.role ?? 'builder',
        type: r.type,
        at: nowIso(),
        note: r.note,
        packageId: r.packageId,
        source: 'receiver',
      };
      await idbPut(STORES.receipts, receipt);
      setState((s) => ({ ...s, receipts: [receipt, ...s.receipts] }));
      await pushAudit({
        type: 'receipt_registered',
        actorAccountId: acc?.accountId ?? r.receiverAccountId,
        actorName: acc?.displayName ?? r.receiverAccountId,
        summary: `${receipt.receiverName} 对 ${r.reportNo} r${r.revision} 登记回执「${r.type}」。`,
        detail: { receiptId: receipt.receiptId, ledgerKey: receipt.ledgerKey },
      });
      return receipt;
    },
    [pushAudit],
  );

  const submitDraft = useCallback(
    async (draftId: string) => {
      const draft = state.drafts.find((d) => d.draftId === draftId);
      if (!draft) return null;
      if (!state.online) {
        notify('err', '离线状态：草案继续保留，恢复联网后才能提交入账。');
        return null;
      }
      const receipt = await addReceipt({
        receiverAccountId: draft.receiverAccountId,
        reportNo: draft.reportNo,
        revision: draft.revision,
        type: draft.type,
        note: draft.note,
      });
      await idbDelete(STORES.drafts, draftId);
      setState((s) => ({ ...s, drafts: s.drafts.filter((d) => d.draftId !== draftId) }));
      notify('ok', '回执草案已提交并记入回执账。');
      return receipt;
    },
    [state.drafts, state.online, addReceipt, notify],
  );

  const adjudicate = useCallback(
    async (ledgerKey: string, outcome: Adjudication['outcome'], rationale: string) => {
      if (!state.server || !account) return;
      const a: Adjudication = {
        adjudicationId: uid('ADJ'),
        ledgerKey,
        at: nowIso(),
        adminAccountId: account.accountId,
        outcome,
        rationale,
      };
      await saveServer({ ...state.server, adjudications: [...state.server.adjudications, a] });
      await pushAudit({
        type: 'conflict_adjudicated',
        actorAccountId: account.accountId,
        actorName: account.displayName,
        summary: `台账 ${ledgerKey} 的确认/质疑矛盾已裁定：${
          outcome === 'uphold_confirmation' ? '确认有效' : '质疑成立'
        }。理由：${rationale}`,
        detail: { ledgerKey, outcome, rationale },
      });
      notify('ok', '冲突裁定已入账。');
    },
    [state.server, account, saveServer, pushAudit, notify],
  );

  const value: StoreValue = {
    ...state,
    account,
    setTab,
    notify,
    login,
    quickSwitch,
    logout,
    setOnline,
    resetDemo,
    licenseFor,
    revokeLicense,
    renewLicense,
    publishRevision2,
    materializePackage,
    releasePackage,
    rebuildPackage,
    revalidatePackage,
    tamperPackage,
    runSemanticGate: runSemanticGateAction,
    saveComment,
    syncComments,
    resolveConflict,
    reportBlockedSignedEdit,
    saveDraft,
    deleteDraft,
    submitDraft,
    addReceipt,
    adjudicate,
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内使用');
  return ctx;
}

// ---------------- 首次启动的预物化包 ----------------
async function seedInitialPackages(server: ServerState, attachments: Attachment[]) {
  const at = nowIso();
  const attachmentMap = new Map(attachments.map((a) => [a.attachmentId, a]));
  const targets: { accountId: string; purpose: 'deliver' | 'audit' }[] = [
    { accountId: 'u-builder', purpose: 'deliver' },
    { accountId: 'u-supervisor', purpose: 'deliver' },
    { accountId: 'u-auditor', purpose: 'audit' },
  ];
  const packages: DeliveryPackage[] = [];
  const events: AuditEvent[] = [];

  for (const t of targets) {
    const acc = ACCOUNTS.find((a) => a.accountId === t.accountId)!;
    const report = server.reports.R1;
    const rev = report.revisions[0];
    const license = findLicense(server.licenses, acc.accountId, 'P');
    if (!license) continue;
    const projection = compileProjection({
      report,
      revision: 1,
      account: acc,
      license,
      purpose: t.purpose,
      mode: 'materialized',
      atIso: at,
      attachmentMap,
    });
    const { pkg } = await buildDeliveryPackage({
      kind: 'materialized',
      report,
      projection,
      account: acc,
      purpose: t.purpose,
      licenseId: license.licenseId,
      licenseVersionAtMaterialize: license.licenseVersion,
      sourceReportHash: rev.reportHash,
      atIso: at,
      validatorContext: { revision: rev, attachments, currentLicense: license },
    });
    packages.push(pkg);
    events.push({
      eventId: uid('AUD'),
      at,
      type: 'package_materialized',
      actorAccountId: 'u-admin',
      actorName: '平台交付管理员',
      summary: `预物化 ${acc.role} 签名交付包 ${pkg.packageId}（R1 r1，固定 ${license.licenseId} v1），支持快速重复交付与离线审阅。`,
      signedDeliverySummary: {
        packageId: pkg.packageId,
        reportHash: pkg.reportHash,
        signature: pkg.signature,
        receiverAccountId: acc.accountId,
        revision: 1,
      },
    });
  }
  return { packages, events };
}
