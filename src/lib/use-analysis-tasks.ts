"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchAnalysisTasks, hasActiveAnalysisTasks } from "@/lib/analysis-queue-client";
import { frontendLogger } from "@/lib/frontend-logger";
import type { AnalysisTaskItem } from "@/types/api";

/**
 * 后台识别任务列表状态：加载后只要还有排队/识别中的任务就定时轮询刷新，
 * 全部结束后停止轮询。refreshKey 变化时立即刷新一次（入队后让列表马上出现新任务）。
 */
export function useAnalysisTasks(refreshKey = 0) {
    const [tasks, setTasks] = useState<AnalysisTaskItem[]>([]);
    const [loaded, setLoaded] = useState(false);

    const refresh = useCallback(async () => {
        try {
            setTasks(await fetchAnalysisTasks());
            setLoaded(true);
        } catch (error) {
            frontendLogger.warn('[AnalysisTasks]', 'Failed to fetch tasks', { error });
        }
    }, []);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 数据请求：挂载与 refreshKey 变化时重新拉取任务列表
        void refresh();
    }, [refresh, refreshKey]);

    const active = hasActiveAnalysisTasks(tasks);
    useEffect(() => {
        if (!active) return;
        const timer = setInterval(() => {
            void refresh();
        }, 4000);
        return () => clearInterval(timer);
    }, [active, refresh]);

    return { tasks, loaded, refresh, active };
}
