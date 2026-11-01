"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { ChevronRight, Images, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AnalysisTaskStatusBadge } from "@/components/analysis-task-status";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTimeZone } from "@/contexts/TimeZoneContext";
import { formatDateTime } from "@/lib/date-time";
import { toast } from "@/lib/feedback";
import { frontendLogger } from "@/lib/frontend-logger";
import { processImageFile } from "@/lib/image-utils";
import { dataUrlToBlob, enqueueAnalysisImage } from "@/lib/analysis-queue-client";
import { useAnalysisTasks } from "@/lib/use-analysis-tasks";
import type { AnalysisTaskItem } from "@/types/api";

interface AnalysisTaskPanelProps {
    /** 上传时放入的错题本（首页带 notebook 参数时）；不传则按识别学科自动匹配 */
    notebookId?: string | null;
    /** 入队成功后递增，通知面板立即刷新 */
    refreshKey: number;
    /** 本面板之外（裁剪上传）入队成功时调用，与 refreshKey 配套 */
    onEnqueued: () => void;
}

function taskSummary(task: AnalysisTaskItem): string | null {
    if (task.status === 'done') return task.resultSummary || task.resultSubject;
    if (task.status === 'failed') return task.errorMessage;
    return task.subjectHint;
}

/**
 * 首页的识别任务近况区：批量选图直接入队 + 最近任务状态（点进 /tasks 看全部与操作）。
 * 识别在后台进行，入队后可立刻继续传下一张，不必等待结果。
 */
export function AnalysisTaskPanel({ notebookId, refreshKey, onEnqueued }: AnalysisTaskPanelProps) {
    const { t, language } = useLanguage();
    const { timeZone } = useTimeZone();
    const { tasks, loaded } = useAnalysisTasks(refreshKey);
    const [enqueueing, setEnqueueing] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const recent = tasks.slice(0, 5);
    const activeCount = tasks.filter((task) => task.status === 'queued' || task.status === 'processing').length;

    /** 批量选图：逐张压缩后入队，入队完成即可关页面，识别在后台继续 */
    const handleFiles = async (files: FileList | null) => {
        if (!files || files.length === 0) return;
        setEnqueueing(true);
        let failed = 0;
        try {
            for (const file of Array.from(files)) {
                try {
                    const dataUrl = await processImageFile(file);
                    await enqueueAnalysisImage(dataUrlToBlob(dataUrl), { notebookId, language });
                } catch (error) {
                    failed++;
                    frontendLogger.error('[AnalysisTaskPanel]', 'Enqueue failed', { error });
                }
            }
            if (failed === 0) {
                toast.success(t.analysisQueue.enqueued);
            } else {
                toast.error(t.analysisQueue.enqueueFailed);
            }
            onEnqueued();
        } finally {
            setEnqueueing(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    return (
        <Card className="shadow-none">
            <CardContent className="space-y-3 py-4">
                <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold">{t.analysisQueue.recentTitle}</h3>
                    {activeCount > 0 && (
                        <span className="text-xs text-muted-foreground">
                            {t.analysisQueue.activeCount.replace('{count}', String(activeCount))}
                        </span>
                    )}
                    <Link href="/tasks" className="ml-auto flex items-center gap-0.5 text-sm text-primary hover:underline">
                        {t.analysisQueue.viewAll}
                        <ChevronRight className="h-4 w-4" />
                    </Link>
                </div>

                <div className="flex flex-col gap-1">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(event) => void handleFiles(event.target.files)}
                    />
                    <Button
                        variant="outline"
                        size="sm"
                        className="w-full sm:w-auto"
                        disabled={enqueueing}
                        onClick={() => fileInputRef.current?.click()}
                    >
                        {enqueueing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Images className="mr-2 h-4 w-4" />}
                        {t.analysisQueue.selectMultiple}
                    </Button>
                    <p className="text-xs text-muted-foreground">{t.analysisQueue.selectMultipleHint}</p>
                </div>

                {loaded && recent.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t.analysisQueue.emptyHome}</p>
                ) : (
                    <ul className="divide-y">
                        {recent.map((task) => (
                            <li key={task.id}>
                                <Link href="/tasks" className="flex items-center gap-2 py-2">
                                    <AnalysisTaskStatusBadge status={task.status} />
                                    <span className="min-w-0 flex-1 truncate text-sm">
                                        {taskSummary(task) || t.analysisQueue.submittedAt.replace('{time}', formatDateTime(task.createdAt, 'MM-dd HH:mm', timeZone))}
                                    </span>
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                        {formatDateTime(task.createdAt, 'HH:mm', timeZone)}
                                    </span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
}
