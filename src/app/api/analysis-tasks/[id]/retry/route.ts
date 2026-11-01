import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { unauthorized, notFound, badRequest, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { getErrorMessage } from "@/lib/error-message";
import { retryAnalysisTask } from "@/lib/analysis-queue";

const logger = createLogger('api:analysis-tasks:retry');

/**
 * POST /api/analysis-tasks/:id/retry
 * 失败或已取消的任务重新入队识别（任务图片仍在时）
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
        let task;
        try {
            task = await retryAnalysisTask(user.id, id);
        } catch (error) {
            if (getErrorMessage(error) === 'TASK_IMAGE_MISSING') {
                return badRequest("TASK_IMAGE_MISSING");
            }
            throw error;
        }
        if (!task) {
            return notFound("Analysis task not found");
        }
        return NextResponse.json({ task: { id: task.id, status: task.status } });
    } catch (error) {
        logger.error({ error: getErrorMessage(error) }, 'Error retrying analysis task');
        return internalError("Failed to retry analysis task");
    }
}
