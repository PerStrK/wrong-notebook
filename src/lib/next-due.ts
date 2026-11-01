/**
 * 到期错题队列中的「下一题」选择逻辑（纯函数，便于单测）。
 *
 * 队列按 nextReviewAt 从早到晚排序，与复习页顺序一致：
 * - 当前题在队列中：取它后面一位；已是末位则没有下一题，返回 null。
 * - 当前题不在队列中（例如刚答完已被移出到期队列，属正常情况）：
 *   取队列中第一个不是当前题的 id，即从队首继续。
 * - 队列为空：返回 null。
 */
export function pickNextDueId(orderedDueIds: readonly string[], currentId: string): string | null {
    const index = orderedDueIds.indexOf(currentId);
    if (index >= 0) {
        return index + 1 < orderedDueIds.length ? orderedDueIds[index + 1] : null;
    }
    for (const id of orderedDueIds) {
        if (id !== currentId) {
            return id;
        }
    }
    return null;
}

/** 错题在到期队列中的位置与相邻题目（详情页连贯翻题用） */
export interface DueNeighbors {
    /** 上一题 id；当前题是首题时为 null */
    prevId: string | null;
    /** 下一题 id；当前题是末题时为 null */
    nextId: string | null;
    /** 当前题在队列中的下标（从 0 开始） */
    index: number;
    /** 队列总题数 */
    total: number;
}

/**
 * 计算当前题在到期队列中的上一题/下一题与位置。
 * 队列顺序与 pickNextDueId 相同（nextReviewAt 从早到晚）；不在队列中返回 null。
 */
export function pickDueNeighbors(orderedDueIds: readonly string[], currentId: string): DueNeighbors | null {
    const index = orderedDueIds.indexOf(currentId);
    if (index < 0) {
        return null;
    }
    return {
        prevId: index > 0 ? orderedDueIds[index - 1] : null,
        nextId: index + 1 < orderedDueIds.length ? orderedDueIds[index + 1] : null,
        index,
        total: orderedDueIds.length,
    };
}
