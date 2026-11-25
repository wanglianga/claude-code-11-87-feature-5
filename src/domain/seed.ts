import type {
  Account,
  Attachment,
  Authorization,
  Project,
  Report,
  ServerState,
} from '../types';
import { hmacSha256Hex, sha256Canonical, sha256Hex, DEMO_SIGNING_SECRET } from './hash';

// ============================================================
// 样例基线：
// 项目 P · 报告 R1 · 修订1（已签署）→ 修订2（裂缝宽度 12.0 → 15.0）
// 另有项目 Q 的无关报告，用于证明审计员“不获得无关项目记录”。
// ============================================================

export const ACCOUNTS: Account[] = [
  {
    accountId: 'u-builder',
    username: 'builder',
    password: 'build1234',
    displayName: '王建国',
    role: 'builder',
    org: '云江市政工程集团 · B1 标段项目部',
    sectionIds: ['B1'],
  },
  {
    accountId: 'u-supervisor',
    username: 'supervisor',
    password: 'sup1234',
    displayName: '李慧敏',
    role: 'supervisor',
    org: '江城工程监理有限公司 · 总监办',
  },
  {
    accountId: 'u-auditor',
    username: 'auditor',
    password: 'audit1234',
    displayName: '赵审',
    role: 'auditor',
    org: '城市建设审计组',
  },
  {
    accountId: 'u-admin',
    username: 'admin',
    password: 'admin1234',
    displayName: '平台交付管理员',
    role: 'admin',
    org: '工程检测机构 · 交付中心',
  },
];

export const PROJECTS: Project[] = [
  {
    projectId: 'P',
    name: '云江大桥结构检测项目',
    sections: [
      { sectionId: 'B1', name: 'B1 标段（K2+300~K3+100）' },
      { sectionId: 'B2', name: 'B2 标段（K3+100~K3+900）' },
    ],
  },
  {
    projectId: 'Q',
    name: '北山隧道定期检测项目（无关项目）',
    sections: [{ sectionId: 'Q1', name: 'Q1 标段' }],
  },
];

interface RawAttachment extends Omit<Attachment, 'sha256' | 'bytes'> {}

const svgPhoto = (title: string, tone: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
  <rect width="640" height="400" fill="#0e1726"/>
  <rect x="24" y="24" width="592" height="352" rx="8" fill="${tone}" opacity="0.18" stroke="${tone}" stroke-width="2"/>
  <path d="M60 300 C160 180, 260 340, 360 220 S540 180, 590 260" fill="none" stroke="${tone}" stroke-width="6" stroke-linecap="round"/>
  <text x="48" y="72" fill="#e6edf6" font-size="26" font-family="sans-serif">${title}</text>
  <text x="48" y="352" fill="#9fb3c8" font-size="18" font-family="monospace">DEMO ATTACHMENT · SHA-256 GUARDED</text>
</svg>`;

const RAW_ATTACHMENTS: RawAttachment[] = [
  {
    attachmentId: 'A-101',
    projectId: 'P',
    sectionId: 'B1',
    defectId: 'D-P-001',
    filename: 'D-P-001_裂缝全景_20261102.svg',
    kind: 'photo',
    contentType: 'image/svg+xml',
    contentText: svgPhoto('D-P-001 腹板斜向裂缝全景', '#38bdf8'),
    supervisorIndexable: true,
  },
  {
    attachmentId: 'A-102',
    projectId: 'P',
    sectionId: 'B1',
    defectId: 'D-P-002',
    filename: 'D-P-002_测宽仪读数_低于检出限.svg',
    kind: 'reading',
    contentType: 'image/svg+xml',
    contentText: svgPhoto('D-P-002 测宽仪读数 0.04mm', '#34d399'),
    supervisorIndexable: true,
  },
  {
    attachmentId: 'A-103',
    projectId: 'P',
    sectionId: 'B1',
    defectId: 'D-P-001',
    filename: 'D-P-001_整改后复测照片.svg',
    kind: 'photo',
    contentType: 'image/svg+xml',
    contentText: svgPhoto('D-P-001 整改后复测', '#a78bfa'),
    supervisorIndexable: true,
  },
  {
    attachmentId: 'A-104',
    projectId: 'P',
    sectionId: 'B1',
    defectId: 'D-P-004',
    filename: 'B1标_施工自检影像_不对外索引.svg',
    kind: 'internal',
    contentType: 'image/svg+xml',
    contentText: svgPhoto('B1 施工单位自检影像（内部）', '#fbbf24'),
    supervisorIndexable: false,
  },
  {
    attachmentId: 'A-201',
    projectId: 'P',
    sectionId: 'B2',
    defectId: 'D-P-003',
    filename: 'D-P-003_B2标墩柱裂缝照片.svg',
    kind: 'photo',
    contentType: 'image/svg+xml',
    contentText: svgPhoto('D-P-003 B2 标段墩柱裂缝', '#fb7185'),
    supervisorIndexable: true,
  },
  {
    attachmentId: 'A-Q-001',
    projectId: 'Q',
    sectionId: 'Q1',
    defectId: 'D-Q-001',
    filename: 'Q项目_无关记录.svg',
    kind: 'photo',
    contentType: 'image/svg+xml',
    contentText: svgPhoto('Q 项目内部照片', '#94a3b8'),
    supervisorIndexable: false,
  },
];

export const ATTACHMENT_TABLE: Attachment[] = [];

const DEFECTS_R1 = [
  {
    defectId: 'D-P-001',
    projectId: 'P',
    sectionId: 'B1',
    coordinate: { x: 51230.46, y: 38821.74 },
    crackWidthMm: 12.03, // 契约 0.1mm → 12.0
    detectionMethod: 'crack_gauge' as const,
    imageSummary: '腹板斜向裂缝，长约 1.8 m，测宽仪多点读数最大值 12.0 mm。',
    rectificationStatus: 'rectified' as const,
    verifiedAt: null as string | null, // 已整改但尚未核验
    attachmentIds: ['A-101', 'A-103'],
  },
  {
    defectId: 'D-P-002',
    projectId: 'P',
    sectionId: 'B1',
    coordinate: { x: 51244.12, y: 38830.08 },
    crackWidthMm: 0.04, // 低于检出限 0.1 → “<0.1”，严禁显示为 0.0
    detectionMethod: 'crack_gauge' as const,
    imageSummary: '龟裂状细纹，仪器读数低于检出限，已留存读数特写。',
    rectificationStatus: 'open' as const,
    verifiedAt: null,
    attachmentIds: ['A-102'],
  },
  {
    defectId: 'D-P-003',
    projectId: 'P',
    sectionId: 'B2',
    coordinate: { x: 51388.91, y: 38902.55 },
    crackWidthMm: 8.62,
    detectionMethod: 'crack_gauge' as const,
    imageSummary: 'B2 标段墩柱竖向裂缝，已封闭并核验。',
    rectificationStatus: 'verified' as const,
    verifiedAt: '2026-11-10T15:30:00+08:00',
    attachmentIds: ['A-201'],
  },
  {
    defectId: 'D-P-004',
    projectId: 'P',
    sectionId: 'B1',
    coordinate: { x: 51251.77, y: 38841.02 },
    crackWidthMm: null, // 尚未测量 —— null 语义必须保留
    detectionMethod: 'visual' as const,
    imageSummary: '新发现龟裂区域，宽度待仪器复测。',
    rectificationStatus: 'in_progress' as const,
    verifiedAt: null,
    attachmentIds: ['A-104'],
  },
];

const DEFECTS_R2 = DEFECTS_R1.map((d) =>
  d.defectId === 'D-P-001'
    ? {
        ...d,
        crackWidthMm: 14.96, // 契约 0.1mm → 15.0（修订2：12.0 → 15.0）
        imageSummary:
          '腹板斜向裂缝复测扩展，测宽仪多点读数最大值 15.0 mm，原整改层局部开裂，需重新处置。',
      }
    : d,
);

const Q_DEFECTS = [
  {
    defectId: 'D-Q-001',
    projectId: 'Q',
    sectionId: 'Q1',
    coordinate: { x: 88.2, y: 102.4 },
    crackWidthMm: 3.2,
    detectionMethod: 'visual' as const,
    imageSummary: '隧道衬砌裂缝（审计员不应获得此项目记录）。',
    rectificationStatus: 'open' as const,
    verifiedAt: null,
    attachmentIds: ['A-Q-001'],
  },
];

function buildLicenses(): Authorization[] {
  return [
    {
      licenseId: 'LIC-BUILDER-P-B1',
      licenseVersion: 1,
      accountId: 'u-builder',
      role: 'builder',
      projectId: 'P',
      sectionIds: ['B1'],
      fieldGroups: ['identity', 'location', 'measurement', 'workflow', 'media'],
      purposes: ['deliver', 'review'],
      validFrom: '2026-01-01T00:00:00+08:00',
      validUntil: '2026-12-31T23:59:59+08:00',
      status: 'active',
      issuedAt: '2026-01-05T09:00:00+08:00',
    },
    {
      licenseId: 'LIC-SUPERVISOR-P',
      licenseVersion: 1,
      accountId: 'u-supervisor',
      role: 'supervisor',
      projectId: 'P',
      sectionIds: ['*'],
      // 监理仅被授权“身份锚点 + 授权附件索引”，其他字段组在编译器中逐字段给出过滤原因
      fieldGroups: ['identity', 'attachmentIndex'],
      purposes: ['deliver', 'review'],
      validFrom: '2026-01-01T00:00:00+08:00',
      validUntil: '2026-12-31T23:59:59+08:00',
      status: 'active',
      issuedAt: '2026-01-05T09:05:00+08:00',
    },
    {
      licenseId: 'LIC-AUDITOR-P',
      licenseVersion: 1,
      accountId: 'u-auditor',
      role: 'auditor',
      projectId: 'P', // 仅 P；项目 Q 无授权
      sectionIds: [],
      // identity 仅用于锚定报告号/修订号；标段维为空，缺陷实体逐条被过滤，
      // 因此审计员能看到修订链与签名，但拿不到任何缺陷记录（交集语义）。
      fieldGroups: ['identity', 'assurance'],
      purposes: ['audit'],
      validFrom: '2026-01-01T00:00:00+08:00',
      validUntil: '2026-12-31T23:59:59+08:00',
      status: 'active',
      issuedAt: '2026-01-05T09:10:00+08:00',
    },
  ];
}

/** 计算附件哈希、报告哈希与修订签名，产出可直接入库的初始服务端状态 */
export async function buildSeedServerState(): Promise<ServerState> {
  // 1) 附件哈希
  const attachments: Attachment[] = [];
  for (const raw of RAW_ATTACHMENTS) {
    const bytes = new TextEncoder().encode(raw.contentText).length;
    const sha256 = await sha256Hex(raw.contentText);
    attachments.push({ ...raw, bytes, sha256 });
  }
  ATTACHMENT_TABLE.length = 0;
  ATTACHMENT_TABLE.push(...attachments);

  // 2) 报告修订哈希 + 签署（签名覆盖 reportHash）
  const hashable = (reportNo: string, revision: number, projectId: string, defects: unknown[]) => ({
    reportNo,
    revision,
    projectId,
    defects,
  });

  const r1Hash = await sha256Canonical(hashable('R1', 1, 'P', DEFECTS_R1));
  const r2Hash = await sha256Canonical(hashable('R1', 2, 'P', DEFECTS_R2));
  const qHash = await sha256Canonical(hashable('RQ-1', 1, 'Q', Q_DEFECTS));

  const signReportHash = (h: string) => hmacSha256Hex(DEMO_SIGNING_SECRET, `report-revision:${h}`);

  const reports: Record<string, Report> = {
    R1: {
      reportNo: 'R1',
      projectId: 'P',
      currentRevision: 1, // 初始基线为修订1；场景中再发布修订2
      revisions: [
        {
          reportNo: 'R1',
          revision: 1,
          projectId: 'P',
          title: '云江大桥主体结构裂缝检测报告',
          publishedAt: '2026-11-03T10:00:00+08:00',
          changeNote: '首次发布。',
          changes: [],
          defects: DEFECTS_R1 as never,
          reportHash: r1Hash,
          signedBy: '江城工程检测有限公司 · 授权签字人 陈立',
          signature: await signReportHash(r1Hash),
          signedAt: '2026-11-03T09:40:00+08:00',
        },
      ],
    },
    RQ1: {
      reportNo: 'RQ-1',
      projectId: 'Q',
      currentRevision: 1,
      revisions: [
        {
          reportNo: 'RQ-1',
          revision: 1,
          projectId: 'Q',
          title: '北山隧道定期检测报告',
          publishedAt: '2026-10-18T10:00:00+08:00',
          changeNote: '首次发布。',
          changes: [],
          defects: Q_DEFECTS as never,
          reportHash: qHash,
          signedBy: '山城工程检测有限公司',
          signature: await signReportHash(qHash),
          signedAt: '2026-10-18T09:00:00+08:00',
        },
      ],
    },
  };

  // 把 r2 的“待发布修订”暂存在模块导出，store 执行“发布修订2”时取用，
  // 保证 r1 是唯一生效基线，场景动作可观察。
  PENDING_R2 = {
    reportNo: 'R1',
    revision: 2,
    projectId: 'P',
    title: '云江大桥主体结构裂缝检测报告',
    publishedAt: '2026-11-25T14:00:00+08:00',
    changeNote: 'D-P-001 复测裂缝扩展，裂缝宽度由 12.0 mm 更正为 15.0 mm，整改结论需重审。',
    changes: [
      { defectId: 'D-P-001', field: 'crackWidthMm', before: 12.0, after: 15.0 },
      {
        defectId: 'D-P-001',
        field: 'imageSummary',
        before: DEFECTS_R1[0].imageSummary,
        after: DEFECTS_R2[0].imageSummary,
      },
    ],
    defects: DEFECTS_R2 as never,
    reportHash: r2Hash,
    signedBy: '江城工程检测有限公司 · 授权签字人 陈立',
    signature: await signReportHash(r2Hash),
    signedAt: '2026-11-25T13:50:00+08:00',
  };

  return {
    licenses: buildLicenses(),
    reports,
    currentReportNo: 'R1',
    adjudications: [],
    serverComments: [],
  };
}

export let PENDING_R2: Report['revisions'][number] | null = null;

export function getAttachments(): Attachment[] {
  return ATTACHMENT_TABLE;
}

export function getAttachmentMap(): Map<string, Attachment> {
  return new Map(ATTACHMENT_TABLE.map((a) => [a.attachmentId, a]));
}
