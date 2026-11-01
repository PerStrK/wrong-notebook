import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { unauthorized, badRequest, internalError, notFound } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { getErrorMessage } from "@/lib/error-message";
import { prisma } from "@/lib/prisma";
import {
    ANALYSIS_TASK_MIME_EXTENSIONS,
    MAX_ANALYSIS_IMAGE_BYTES,
    enqueueAnalysisTask,
    kickAnalysisQueue,
    listAnalysisTasks,
} from "@/lib/analysis-queue";
import type { AnalysisTaskItem } from "@/types/api";
import type { AnalysisTask } from "@prisma/client";

const logger = createLogger('api:analysis-tasks');

/** 任务记录转前端结构（不暴露图片存储路径） */
function toTaskItem(task: AnalysisTask): AnalysisTaskItem {
    return {
        id: task.id,
        status: task.status as AnalysisTaskItem['status'],
        notebookId: task.notebookId,
        subjectHint: task.subjectHint,
        language: task.language === 'en' ? 'en' : 'zh',
        errorItemId: task.errorItemId,
        resultSubject: task.resultSubject,
        resultSummary: task.resultSummary,
        errorMessage: task.errorMessage,
        createdAt: task.createdAt.toISOString(),
        startedAt: task.startedAt?.toISOString() ?? null,
        finishedAt: task.finishedAt?.toISOString() ?? null,
    };
}

/**
 * GET /api/analysis-tasks
 * 当前用户的识别任务列表（倒序），并顺带触发队列处理（服务重启后也能恢复排队）
 */
export async function GET() {
    try {
        const user = await getCurrentUser();
        if (!user) {
            return unauthorized("Authentication required");
        }
        kickAnalysisQueue();
        const tasks = await listAnalysisTasks(user.id);
        return NextResponse.json({ tasks: tasks.map(toTaskItem) });
    } catch (error) {
        logger.error({ error: getErrorMessage(error) }, 'Error listing analysis tasks');
        return internalError("Failed to list analysis tasks");
    }
}

/**
 * POST /api/analysis-tasks
 * 上传一张题目图片加入后台识别队列：只存图建任务就立即返回，识别在后台进行、不设超时。
 * 表单字段：image（图片文件，必填）、notebookId（可选，目标错题本）、language（可选，zh/en）
 */
export async function POST(req: Request) {
    try {
        const user = await getCurrentUser();
        if (!user) {
            return unauthorized("Authentication required");
        }

        const form = await req.formData();
        const image = form.get('image');
        if (!(image instanceof File)) {
            return badRequest("Missing image file");
        }
        if (!ANALYSIS_TASK_MIME_EXTENSIONS[image.type]) {
            return badRequest("Unsupported image type");
        }
        if (image.size === 0 || image.size > MAX_ANALYSIS_IMAGE_BYTES) {
            return badRequest("Image size out of range");
        }

        // 指定错题本时校验归属，并记录名称快照供任务列表展示
        let notebookId: string | null = null;
        let subjectHint: string | null = null;
        const requestedNotebookId = form.get('notebookId');
        if (typeof requestedNotebookId === 'string' && requestedNotebookId) {
            const notebook = await prisma.subject.findUnique({
                where: { id: requestedNotebookId },
                select: { id: true, name: true, userId: true },
            });
            if (!notebook || notebook.userId !== user.id) {
                return notFound("Notebook not found");
            }
            notebookId = notebook.id;
            subjectHint = notebook.name;
        }

        const language = form.get('language') === 'en' ? 'en' : 'zh';
        const buffer = Buffer.from(await image.arrayBuffer());
        const task = await enqueueAnalysisTask({
            userId: user.id,
            image: buffer,
            mimeType: image.type,
            notebookId,
            subjectHint,
            language,
        });

        return NextResponse.json({ task: toTaskItem(task) }, { status: 201 });
    } catch (error) {
        logger.error({ error: getErrorMessage(error) }, 'Error creating analysis task');
        return internalError("Failed to create analysis task");
    }
}
