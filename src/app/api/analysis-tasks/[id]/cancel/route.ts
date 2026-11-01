import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { unauthorized, notFound, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { getErrorMessage } from "@/lib/error-message";
import { cancelAnalysisTask } from "@/lib/analysis-queue";

const logger = createLogger('api:analysis-tasks:cancel');

/**
 * POST /api/analysis-tasks/:id/cancel
 * 取消排队中或识别中的任务；识别中的任务在 AI 返回后丢弃结果、不建题
 */
export async function POST(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const user = await getCurrentUser();
        if (!user) {
            return unauthorized("Authentication required");
        }
        const { id } = await params;
        const task = await cancelAnalysisTask(user.id, id);
        if (!task) {
            return notFound("Analysis task not found");
        }
        return NextResponse.json({ task: { id: task.id, status: task.status } });
    } catch (error) {
        logger.error({ error: getErrorMessage(error) }, 'Error cancelling analysis task');
        return internalError("Failed to cancel analysis task");
    }
}
