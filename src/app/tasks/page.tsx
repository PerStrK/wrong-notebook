"use client";

import { useState } from "react";
import Link from "next/link";
import { Ban, ExternalLink, ListTodo, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PageLoading } from "@/components/ui/page-loading";
import { AnalysisTaskStatusBadge } from "@/components/analysis-task-status";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTimeZone } from "@/contexts/TimeZoneContext";
import { formatDateTime } from "@/lib/date-time";
import { toast } from "@/lib/feedback";
import { frontendLogger } from "@/lib/frontend-logger";
import { cancelAnalysisTask, retryAnalysisTask } from "@/lib/analysis-queue-client";
import { useAnalysisTasks } from "@/lib/use-analysis-tasks";
import { usePageTitle } from "@/lib/page-title";
import type { AnalysisTaskItem } from "@/types/api";

/** 任务行右侧的元信息：目标错题本、识别学科、题干摘要与失败原因 */
function TaskMeta({ task }: { task: AnalysisTaskItem }) {
    const { t } = useLanguage();
    const lines: string[] = [];
    if (task.subjectHint) lines.push(t.analysisQueue.notebookLabel.replace('{name}', task.subjectHint));
    if (task.status === 'done') {
        if (task.resultSubject) lines.push(t.analysisQueue.subjectLabel.replace('{name}', task.resultSubject));
        if (task.resultSummary) lines.push(task.resultSummary);
    }
    if (task.status === 'failed' && task.errorMessage) lines.push(task.errorMessage);
    if (lines.length === 0) return null;
    return (
        <div className="space-y-0.5">
            {lines.map((line, index) => (
                <p key={index} className={`truncate text-sm ${task.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>
                    {line}
                </p>
            ))}
        </div>
    );
}

function TaskRow({ task, onChanged }: { task: AnalysisTaskItem; onChanged: () => Promise<void> }) {
    const { t } = useLanguage();
    const { timeZone } = useTimeZone();
    const [acting, setActing] = useState(false);
    const [imageVisible, setImageVisible] = useState(true);

    const act = async (action: () => Promise<void>) => {
        setActing(true);
        try {
            await action();
            await onChanged();
        } catch (error) {
            frontendLogger.error('[Tasks]', 'Task action failed', { error });
            toast.error(t.common.messages.saveFailed);
        } finally {
            setActing(false);
        }
    };

    return (
        <Card className="shadow-none">
            <CardContent className="flex gap-3 py-3">
                {imageVisible && task.status !== 'done' ? (
                    // 任务图片还在时显示缩略图；识别成功后图片已转存错题，这里自动隐藏
                    <img
                        src={`/api/analysis-tasks/${task.id}/image`}
                        alt=""
                        className="h-16 w-16 shrink-0 rounded-md border object-cover"
                        onError={() => setImageVisible(false)}
                    />
                ) : null}
                <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                        <AnalysisTaskStatusBadge status={task.status} />
                        <span className="text-xs text-muted-foreground">
                            {t.analysisQueue.submittedAt.replace('{time}', formatDateTime(task.createdAt, 'yyyy-MM-dd HH:mm', timeZone))}
                        </span>
                    </div>
                    <TaskMeta task={task} />
                    <div className="flex flex-wrap gap-2 pt-0.5">
                        {(task.status === 'queued' || task.status === 'processing') && (
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={acting}
                                onClick={() => void act(() => cancelAnalysisTask(task.id))}
                            >
                                <Ban className="mr-1.5 h-3.5 w-3.5" />
                                {t.analysisQueue.cancel}
                            </Button>
                        )}
                        {(task.status === 'failed' || task.status === 'cancelled') && (
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={acting}
                                onClick={() => void act(() => retryAnalysisTask(task.id))}
                            >
                                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                                {t.analysisQueue.retry}
                            </Button>
                        )}
                        {task.status === 'done' && task.errorItemId && (
                            <Link href={`/error-items/${task.errorItemId}`}>
                                <Button variant="outline" size="sm">
                                    <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                                    {t.analysisQueue.viewItem}
                                </Button>
                            </Link>
                        )}
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}

/** 后台任务页：查看拍照识别队列的进度，取消或重试任务；有进行中任务时自动刷新 */
export default function TasksPage() {
    const { t } = useLanguage();
    usePageTitle(t.analysisQueue.title);
    const { tasks, loaded, refresh } = useAnalysisTasks();

    if (!loaded) return <PageLoading label={t.common.loading} />;

    return (
        <main className="mx-auto min-h-screen max-w-4xl px-4 py-6 md:px-8 md:py-8">
            <div className="space-y-4">
                <PageHeader title={t.analysisQueue.title} description={t.analysisQueue.subtitle} />
                {tasks.length === 0 ? (
                    <EmptyState icon={ListTodo} title={t.analysisQueue.empty} />
                ) : (
                    tasks.map((task) => <TaskRow key={task.id} task={task} onChanged={refresh} />)
                )}
            </div>
        </main>
    );
}
