import type { Report, ReviewComment } from '../types';
import { getContract } from './contracts';

// ============================================================
// 离线审阅意见合并
//  - 意见在离线时创建，必须带 commentId 与基线（报告修订+哈希）
//  - 恢复联网后按 commentId 与服务端合并（同 ID 幂等，不产生重复）
//  - 合并后依据修订链计算“需对新修订重审”标记
// ============================================================

export interface CommentMergeItem {
  commentId: string;
  action: 'inserted' | 'updated_local_wins' | 'already_synced' | 'conflict';
  comment: ReviewComment;
}

export interface MergeOutcome {
  serverComments: ReviewComment[];
  items: CommentMergeItem[];
  mergedAt: string;
}

export function mergeOfflineComments(args: {
  localComments: ReviewComment[];
  serverComments: ReviewComment[];
  report: Report;
  atIso: string;
}): MergeOutcome {
  const { localComments, report, atIso } = args;
  const server = new Map(args.serverComments.map((c) => [c.commentId, { ...c }]));
  const items: CommentMergeItem[] = [];

  for (const local of localComments) {
    const existing = server.get(local.commentId);

    if (local.syncState === 'synced' && !existing) {
      // 理论上不应发生：已同步但服务端缺失，按插入修复
      const repaired: ReviewComment = { ...local, syncState: 'synced' };
      server.set(local.commentId, repaired);
      items.push({ commentId: local.commentId, action: 'inserted', comment: repaired });
      continue;
    }

    if (!existing) {
      const inserted: ReviewComment = { ...local, syncState: 'synced', updatedAt: atIso };
      server.set(local.commentId, inserted);
      items.push({ commentId: local.commentId, action: 'inserted', comment: inserted });
      continue;
    }

    // 同 ID 合并：服务端存在更新的并行编辑 → 冲突，交由人工选择
    const localTime = new Date(local.updatedAt).getTime();
    const serverTime = new Date(existing.updatedAt).getTime();
    if (local.body !== existing.body && serverTime > localTime && local.syncState === 'pending') {
      const conflicted: ReviewComment = {
        ...local,
        syncState: 'merge-conflict',
        serverBody: existing.body,
        serverUpdatedAt: existing.updatedAt,
      };
      // 服务端副本保持原样，冲突只落在本地意见上，等待人工选择
      items.push({ commentId: local.commentId, action: 'conflict', comment: conflicted });
      continue;
    }

    if (local.body === existing.body) {
      const same: ReviewComment = { ...existing, syncState: 'synced' };
      server.set(local.commentId, same);
      items.push({ commentId: local.commentId, action: 'already_synced', comment: same });
      continue;
    }

    // 本地更新 → 按意见ID覆盖合并
    const merged: ReviewComment = { ...existing, ...local, syncState: 'synced', updatedAt: atIso };
    server.set(local.commentId, merged);
    items.push({ commentId: local.commentId, action: 'updated_local_wins', comment: merged });
  }

  // 计算重审标记：基线修订之后，同一缺陷在更新修订中发生了字段变化
  const serverComments = [...server.values()].map((c) => applyReReviewFlag(c, report));
  const itemsFinal = items.map((i) => ({ ...i, comment: applyReReviewFlag(i.comment, report) }));

  return {
    serverComments,
    items: itemsFinal,
    mergedAt: atIso,
  };
}

export function applyReReviewFlag(comment: ReviewComment, report: Report): ReviewComment {
  if (comment.reportNo !== report.reportNo) return comment;
  const head = report.currentRevision;
  if (comment.baseline.revision >= head) {
    return { ...comment, needsReReviewFor: undefined, changedFields: undefined };
  }
  const laterChanges = report.revisions
    .filter((r) => r.revision > comment.baseline.revision && r.revision <= head)
    .flatMap((r) => r.changes)
    .filter((ch) => ch.defectId === comment.defectId);

  if (laterChanges.length === 0) {
    return { ...comment, needsReReviewFor: undefined, changedFields: undefined };
  }
  const labels = Array.from(new Set(laterChanges.map((ch) => contractLabel(ch.field))));
  return { ...comment, needsReReviewFor: head, changedFields: labels };
}

function contractLabel(fieldKey: string): string {
  // changes 中存的是源字段名（crackWidthMm），投影键可能不同；契约表按源键注册
  try {
    return getContract(fieldKey).label;
  } catch {
    return fieldKey;
  }
}

/** 解决同 ID 合并冲突：选择本地或服务端文本 */
export function resolveCommentConflict(
  comment: ReviewComment,
  choose: 'local' | 'server',
  atIso: string,
): ReviewComment {
  if (choose === 'server') {
    return {
      ...comment,
      body: comment.serverBody ?? comment.body,
      syncState: 'synced',
      serverBody: undefined,
      serverUpdatedAt: undefined,
      updatedAt: atIso,
    };
  }
  // 本地版本胜出：刷新 updatedAt，使再次合并时本地时间不旧于服务端，
  // 并置为 pending 等待下一次同步写入。
  return {
    ...comment,
    syncState: 'pending',
    serverBody: undefined,
    serverUpdatedAt: undefined,
    updatedAt: atIso,
  };
}
