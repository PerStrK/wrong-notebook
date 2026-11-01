import fs from "node:fs";
import { getCurrentUser } from "@/lib/current-user";
import { unauthorized, notFound } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { getErrorMessage } from "@/lib/error-message";
import { getAnalysisTask } from "@/lib/analysis-queue";

const logger = createLogger('api:analysis-tasks:image');

/**
 * GET /api/analysis-tasks/:id/image
 * 返回任务图片供列表缩略图展示（仅任务本人）；识别成功建题后图片已删除，此时返回 404，
 * 前端改从错题详情查看原图。
 */
export async function GET(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const user = await getCurrentUser();
        if (!user) {
            return unauthorized("Authentication required");
        }
        const { id } = await params;
        const task = await getAnalysisTask(user.id, id);
        if (!task || !task.imagePath) {
            return notFound("Analysis task image not found");
        }
        let data: Buffer;
        try {
            data = await fs.promises.readFile(task.imagePath);
        } catch {
            return notFound("Analysis task image not found");
        }
        return new Response(new Uint8Array(data), {
            headers: {
                'Content-Type': task.mimeType,
                'Cache-Control': 'private, max-age=300',
            },
        });
    } catch (error) {
        logger.error({ error: getErrorMessage(error) }, 'Error reading analysis task image');
        return notFound("Analysis task image not found");
    }
}
