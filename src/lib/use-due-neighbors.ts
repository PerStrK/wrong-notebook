"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { MAX_PAGE_SIZE } from "@/lib/constants/pagination";
import { frontendLogger } from "@/lib/frontend-logger";
import { pickDueNeighbors } from "@/lib/next-due";
import type { DueNeighbors } from "@/lib/next-due";
import type { DueReviewItem, PaginatedResponse } from "@/types/api";

/**
 * 当前错题在到期复习队列中的相邻题目（详情页连贯翻题用）。
 *
 * 与复习页同序（nextReviewAt 从早到晚）分页拉取整个队列，再交给
 * pickDueNeighbors 计算上一题/下一题与位置；因为要报告队列总数，
 * 不像 use-next-due 那样定位到当前题就提前结束。当前题不在队列中时
 * neighbors 为 null；拉取失败时保持未解析（resolved 为 false），
 * 页面不显示导航，不打扰用户。
 */
export function useDueNeighbors(currentId: string | null) {
    const [state, setState] = useState<{ id: string; neighbors: DueNeighbors | null } | null>(null);

    useEffect(() => {
        if (!currentId) {
            return;
        }
        let cancelled = false;
        const load = async () => {
            try {
                const ids: string[] = [];
                let page = 1;
                let total = Number.POSITIVE_INFINITY;
                while (ids.length < total) {
                    const data = await apiClient.get<PaginatedResponse<DueReviewItem>>(
                        `/api/review/due?page=${page}&pageSize=${MAX_PAGE_SIZE}`,
                    );
                    total = data.total;
                    ids.push(...data.items.map((item) => item.id));
                    if (data.items.length === 0) {
                        break;
                    }
                    page += 1;
                }
                if (!cancelled) {
                    setState({ id: currentId, neighbors: pickDueNeighbors(ids, currentId) });
                }
            } catch (error) {
                frontendLogger.error('[ErrorDetail]', 'Failed to fetch due queue for neighbors', { error });
            }
        };
        void load();
        return () => { cancelled = true; };
    }, [currentId]);

    if (!state || state.id !== currentId) {
        return { neighbors: null, resolved: false };
    }
    return { neighbors: state.neighbors, resolved: true };
}
