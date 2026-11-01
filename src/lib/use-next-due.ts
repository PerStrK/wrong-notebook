"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { MAX_PAGE_SIZE } from "@/lib/constants/pagination";
import { frontendLogger } from "@/lib/frontend-logger";
import { pickNextDueId } from "@/lib/next-due";
import type { DueReviewItem, PaginatedResponse } from "@/types/api";

/**
 * 练习提交判分后，计算下一道到期错题。
 *
 * 按复习页同序（nextReviewAt 从早到晚）分页拉取到期队列：定位到当前题
 * 且其后一位已在手中即可提前结束；当前题不在已拉取部分时继续翻页，
 * 直到找到当前题或取满整个队列，再交给 pickNextDueId 选择。
 * 拉取失败时保持未解析（resolved 为 false），页面不显示下一题区域，不打扰用户。
 */
export function useNextDueQuestion(currentId: string | null, enabled: boolean) {
    const [nextId, setNextId] = useState<string | null>(null);
    const [resolved, setResolved] = useState(false);

    useEffect(() => {
        if (!enabled || !currentId) {
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
                    const index = ids.indexOf(currentId);
                    if (index >= 0 && index + 1 < ids.length) {
                        break;
                    }
                    if (data.items.length === 0) {
                        break;
                    }
                    page += 1;
                }
                if (!cancelled) {
                    setNextId(pickNextDueId(ids, currentId));
                    setResolved(true);
                }
            } catch (error) {
                frontendLogger.error('[Practice]', 'Failed to fetch due queue for next question', { error });
            }
        };
        void load();
        return () => { cancelled = true; };
    }, [currentId, enabled]);

    return { nextId, resolved };
}
