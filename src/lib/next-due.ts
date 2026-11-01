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
