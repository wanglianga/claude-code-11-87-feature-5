import { describe, expect, it } from 'vitest';
import { deriveLedger, ledgerKeyOf } from './receipts';
import { mergeOfflineComments } from './merge';
import type { Adjudication, Receipt, Report, ReviewComment } from '../types';

function receipt(partial: Partial<Receipt> & Pick<Receipt, 'ledgerKey' | 'type'>): Receipt {
  return {
    receiptId: `r_${Math.random().toString(36).slice(2)}`,
    projectId: 'P',
    reportNo: 'R1',
    revision: 2,
    receiverAccountId: 'u-builder',
    receiverName: '王建国',
    receiverRole: 'builder',
    at: new Date(Date.parse('2026-11-25T10:00:00Z') + Math.random() * 1e6).toISOString(),
    source: 'receiver',
    ...partial,
  };
}

describe('回执账状态机', () => {
  const key = ledgerKeyOf('u-builder', 'R1', 2);

  it('传输已收到 ≠ 语义确认，即使追加多条传输回执', () => {
    const receipts = [
      receipt({ ledgerKey: key, type: 'transmit_received' }),
      receipt({ ledgerKey: key, type: 'transmit_received' }),
    ];
    const view = deriveLedger(key, receipts, []);
    expect(view.flags.transmit).toBe(true);
    expect(view.flags.confirmed).toBe(false);
    expect(view.semanticConfirmed).toBe(false);
    expect(view.state).toBe('transmit_received');
  });

  it('结构解析也不产生语义确认', () => {
    const receipts = [
      receipt({ ledgerKey: key, type: 'transmit_received' }),
      receipt({ ledgerKey: key, type: 'structure_parsed' }),
    ];
    const view = deriveLedger(key, receipts, []);
    expect(view.state).toBe('structure_parsed');
    expect(view.semanticConfirmed).toBe(false);
  });

  it('确认 + 质疑并存 → conflict；裁定后落终态', () => {
    const receipts = [
      receipt({ ledgerKey: key, type: 'semantic_confirmed' }),
      receipt({ ledgerKey: key, type: 'questioned' }),
    ];
    const conflict = deriveLedger(key, receipts, []);
    expect(conflict.inConflict).toBe(true);
    expect(conflict.state).toBe('conflict');

    const adj: Adjudication = {
      adjudicationId: 'a1',
      ledgerKey: key,
      at: '2026-11-25T12:00:00Z',
      adminAccountId: 'u-admin',
      outcome: 'uphold_question',
      rationale: '宽度已变化',
    };
    const ruled = deriveLedger(key, receipts, [adj]);
    expect(ruled.inConflict).toBe(false);
    expect(ruled.state).toBe('adjudicated_question');
    expect(ruled.semanticConfirmed).toBe(false);
  });

  it('不同修订的账本相互隔离：r1 确认不能算 r2 确认', () => {
    const k1 = ledgerKeyOf('u-builder', 'R1', 1);
    const k2 = ledgerKeyOf('u-builder', 'R1', 2);
    const receipts = [receipt({ ledgerKey: k1, revision: 1, type: 'semantic_confirmed' })];
    expect(deriveLedger(k1, receipts, []).semanticConfirmed).toBe(true);
    expect(deriveLedger(k2, receipts, []).semanticConfirmed).toBe(false);
    expect(deriveLedger(k2, receipts, []).state).toBe('none');
  });
});

describe('离线意见按 ID 合并与重审标记', () => {
  const report = {
    reportNo: 'R1',
    currentRevision: 2,
    revisions: [
      { revision: 1 },
      {
        revision: 2,
        changes: [{ defectId: 'D-P-001', field: 'crackWidthMm', before: 12.0, after: 15.0 }],
      },
    ],
  } as unknown as Report;

  const baseComment: ReviewComment = {
    commentId: 'CMT-1',
    projectId: 'P',
    reportNo: 'R1',
    defectId: 'D-P-001',
    body: '缺陷已复测',
    authorAccountId: 'u-builder',
    authorName: '王建国',
    baseline: { reportNo: 'R1', revision: 1, reportHash: 'h1' },
    createdAt: '2026-11-25T08:00:00Z',
    updatedAt: '2026-11-25T08:00:00Z',
    syncState: 'local-only',
  };

  it('新意见按 ID 插入并标记 synced，且计算需对 r2 重审', () => {
    const out = mergeOfflineComments({
      localComments: [baseComment],
      serverComments: [],
      report,
      atIso: '2026-11-25T15:00:00Z',
    });
    expect(out.serverComments).toHaveLength(1);
    expect(out.items[0].action).toBe('inserted');
    expect(out.serverComments[0].syncState).toBe('synced');
    expect(out.serverComments[0].baseline.revision).toBe(1);
    expect(out.serverComments[0].needsReReviewFor).toBe(2);
    expect(out.serverComments[0].changedFields?.[0]).toBe('裂缝宽度');
  });

  it('重复同步同 ID 不产生重复意见（幂等）', () => {
    const first = mergeOfflineComments({
      localComments: [baseComment],
      serverComments: [],
      report,
      atIso: '2026-11-25T15:00:00Z',
    });
    const again = mergeOfflineComments({
      localComments: [first.items[0].comment],
      serverComments: first.serverComments,
      report,
      atIso: '2026-11-25T15:05:00Z',
    });
    expect(again.serverComments).toHaveLength(1);
    expect(again.items[0].action).toBe('already_synced');
  });

  it('基线已是最新修订时不打重审标记', () => {
    const fresh: ReviewComment = {
      ...baseComment,
      commentId: 'CMT-2',
      baseline: { reportNo: 'R1', revision: 2, reportHash: 'h2' },
    };
    const out = mergeOfflineComments({
      localComments: [fresh],
      serverComments: [],
      report,
      atIso: '2026-11-25T15:00:00Z',
    });
    expect(out.serverComments[0].needsReReviewFor).toBeUndefined();
  });
});
