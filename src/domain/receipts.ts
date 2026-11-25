import type { Adjudication, LedgerState, Receipt, ReceiptType } from '../types';

// ============================================================
// 回执账：传输已收到 / 结构已解析 / 语义已确认 / 提出质疑 / 被更正
// 关键规则：
//  - “传输已收到”永远不会被推导为语义确认；
//  - 同一接收方对同一修订同时存在确认与质疑 → conflict，
//    须经冲突裁定才落到终态。
// ============================================================

export function ledgerKeyOf(receiverAccountId: string, reportNo: string, revision: number): string {
  return `${receiverAccountId}::${reportNo}#r${revision}`;
}

export const RECEIPT_LABELS: Record<ReceiptType, string> = {
  transmit_received: '传输已收到',
  structure_parsed: '结构已解析',
  semantic_confirmed: '语义已确认',
  questioned: '提出质疑',
  corrected: '被更正',
};

export interface LedgerView {
  key: string;
  receipts: Receipt[];
  adjudication?: Adjudication;
  flags: {
    transmit: boolean;
    parsed: boolean;
    confirmed: boolean;
    questioned: boolean;
    corrected: boolean;
  };
  state: LedgerState;
  stateLabel: string;
  /** 语义是否已确认（传输/解析回执不得影响此值） */
  semanticConfirmed: boolean;
  inConflict: boolean;
}

export function deriveLedger(
  key: string,
  receipts: Receipt[],
  adjudications: Adjudication[],
): LedgerView {
  const entries = receipts
    .filter((r) => r.ledgerKey === key)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  const flags = {
    transmit: entries.some((r) => r.type === 'transmit_received'),
    parsed: entries.some((r) => r.type === 'structure_parsed'),
    confirmed: entries.some((r) => r.type === 'semantic_confirmed'),
    questioned: entries.some((r) => r.type === 'questioned'),
    corrected: entries.some((r) => r.type === 'corrected'),
  };

  const adjudication = adjudications
    .filter((a) => a.ledgerKey === key)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())[0];

  const inConflict = flags.confirmed && flags.questioned && !adjudication;

  let state: LedgerState;
  if (adjudication) {
    state =
      adjudication.outcome === 'uphold_confirmation'
        ? 'adjudicated_confirm'
        : 'adjudicated_question';
  } else if (flags.confirmed && flags.questioned) {
    state = 'conflict';
  } else if (flags.questioned) {
    state = 'questioned';
  } else if (flags.confirmed) {
    state = 'semantic_confirmed';
  } else if (flags.corrected) {
    state = 'corrected';
  } else if (flags.parsed) {
    state = 'structure_parsed';
  } else if (flags.transmit) {
    state = 'transmit_received';
  } else {
    state = 'none';
  }

  return {
    key,
    receipts: entries,
    adjudication,
    flags,
    state,
    stateLabel: LEDGER_STATE_LABELS[state],
    semanticConfirmed:
      state === 'semantic_confirmed' || state === 'adjudicated_confirm',
    inConflict,
  };
}

export const LEDGER_STATE_LABELS: Record<LedgerState, string> = {
  none: '暂无回执',
  transmit_received: '仅传输已收到',
  structure_parsed: '结构已解析',
  semantic_confirmed: '语义已确认',
  questioned: '已提出质疑',
  conflict: '确认/质疑矛盾 · 待裁定',
  adjudicated_confirm: '冲突已裁定：确认有效',
  adjudicated_question: '冲突已裁定：质疑成立',
  corrected: '内容已被后续修订更正',
};

/** 只有 semantic_confirmed 类型才表达语义确认，杜绝把传输回执误记为确认 */
export function isSemanticReceipt(type: ReceiptType): boolean {
  return type === 'semantic_confirmed';
}
