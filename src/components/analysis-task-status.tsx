import { Ban, CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useLanguage } from "@/contexts/LanguageContext";
import type { AnalysisTaskStatus } from "@/types/api";

const STATUS_STYLE: Record<AnalysisTaskStatus, { className: string; icon: typeof Clock }> = {
    queued: { className: "bg-warning/15 text-amber-700 dark:text-warning", icon: Clock },
    processing: { className: "bg-primary/10 text-primary", icon: Loader2 },
    done: { className: "bg-success/15 text-success", icon: CheckCircle2 },
    failed: { className: "bg-destructive/10 text-destructive", icon: XCircle },
    cancelled: { className: "bg-muted text-muted-foreground", icon: Ban },
};

/** 后台识别任务状态徽标 */
export function AnalysisTaskStatusBadge({ status }: { status: AnalysisTaskStatus }) {
    const { t } = useLanguage();
    const { className, icon: Icon } = STATUS_STYLE[status];
    const label = {
        queued: t.analysisQueue.statusQueued,
        processing: t.analysisQueue.statusProcessing,
        done: t.analysisQueue.statusDone,
        failed: t.analysisQueue.statusFailed,
        cancelled: t.analysisQueue.statusCancelled,
    }[status];

    return (
        <Badge variant="secondary" className={className}>
            <span className="flex items-center gap-1">
                <Icon className={`h-3 w-3 ${status === 'processing' ? 'animate-spin' : ''}`} />
                {label}
            </span>
        </Badge>
    );
}
