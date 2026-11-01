import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AnalysisTask } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAIService } from "@/lib/ai";
import { consumeAiQuota } from "@/lib/ai-quota";
import { ErrorCode } from "@/lib/api-errors";
import { getAppTimeZone } from "@/lib/config";
import { getErrorMessage } from "@/lib/error-message";
import { createLogger } from "@/lib/logger";
import { getNotebookCandidateTags } from "@/lib/ai/tag-service";
import { resolveNotebookScope, SUBJECT_DISPLAY_NAMES } from "@/lib/notebook-scope";
import { getQuestionGradeContext } from "@/lib/question-grade";
import type { CandidateTags } from "@/lib/ai/types";
import { importAnalyzedQuestion } from "@/lib/analysis-import";
import { describeQuestion } from "@/lib/background-tasks";

const logger = createLogger('analysis-queue');

/** 任务状态（与 AnalysisTask.status 存储值一致） */
export type AnalysisTaskStatus = 'queued' | 'processing' | 'done' | 'failed' | 'cancelled';

/** 允许入队的图片类型与扩展名 */
export const ANALYSIS_TASK_MIME_EXTENSIONS: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
};

/** 单张任务图片大小上限（与错题原图存储上限保持一致） */
export const MAX_ANALYSIS_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * 数据目录：与 SQLite 数据库同目录（生产环境为持久卷上的 data 目录）。
 * 任务图片放在其下的 analysis-tasks 子目录，容器重启不丢失。
 */
export function getAnalysisTaskDir(): string {
    const url = process.env.DATABASE_URL || 'file:./data/dev.db';
    const filePath = url.startsWith('file:') ? url.slice('file:'.length).split('?')[0] : '';
    const dataDir = filePath ? path.dirname(path.resolve(filePath)) : path.join(process.cwd(), 'data');
    return path.join(dataDir, 'analysis-tasks');
}

function taskImagePath(taskId: string, mimeType: string): string {
    const ext = ANALYSIS_TASK_MIME_EXTENSIONS[mimeType] || 'jpg';
    return path.join(getAnalysisTaskDir(), `${taskId}.${ext}`);
}

function deleteTaskImage(imagePath: string): void {
    fs.promises.unlink(imagePath).catch(() => {
        // 文件已不存在时忽略，删除失败不影响任务状态
    });
}

/** 失败原因归一化：AI 错误只保留错误码，其余截断，避免把长堆栈写进任务记录 */
function normalizeTaskError(error: unknown): string {
    const message = getErrorMessage(error);
    return (message.startsWith('AI_') ? message.split(':')[0] : message).slice(0, 200);
}

export interface EnqueueAnalysisTaskInput {
    userId: string;
    image: Buffer;
    mimeType: string;
    notebookId?: string | null;
    subjectHint?: string | null;
    language?: 'zh' | 'en';
}

/** 创建一条排队任务并保存图片，立即返回（不等待识别） */
export async function enqueueAnalysisTask(input: EnqueueAnalysisTaskInput): Promise<AnalysisTask> {
    // 先定 id 并写好图片再建任务行，避免队列处理器抢到图片未就绪的任务
    const taskId = randomUUID();
    const imagePath = taskImagePath(taskId, input.mimeType);
    await fs.promises.mkdir(path.dirname(imagePath), { recursive: true });
    await fs.promises.writeFile(imagePath, input.image);
    try {
        const task = await prisma.analysisTask.create({
            data: {
                id: taskId,
                userId: input.userId,
                status: 'queued',
                imagePath,
                mimeType: input.mimeType,
                notebookId: input.notebookId || null,
                subjectHint: input.subjectHint || null,
                language: input.language || 'zh',
            },
        });
        logger.info({ taskId: task.id, userId: input.userId }, 'Analysis task enqueued');
        kickAnalysisQueue();
        return task;
    } catch (error) {
        deleteTaskImage(imagePath);
        throw error;
    }
}

/** 当前用户的任务列表（按提交时间倒序） */
export async function listAnalysisTasks(userId: string, limit = 50): Promise<AnalysisTask[]> {
    return prisma.analysisTask.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
    });
}

/** 读取一条属于当前用户的任务，不存在或不属于该用户时返回 null */
export async function getAnalysisTask(userId: string, taskId: string): Promise<AnalysisTask | null> {
    return prisma.analysisTask.findFirst({ where: { id: taskId, userId } });
}

/**
 * 取消任务：排队中的直接取消；识别中的同样置为已取消——处理器在 AI 返回后会先检查状态，
 * 已取消则丢弃识别结果、绝不建题（处理器的所有状态写回都以 status=processing 为条件，不会覆盖取消）。
 */
export async function cancelAnalysisTask(userId: string, taskId: string): Promise<AnalysisTask | null> {
    const task = await getAnalysisTask(userId, taskId);
    if (!task) return null;
    if (task.status !== 'queued' && task.status !== 'processing') return task;
    const updated = await prisma.analysisTask.update({
        where: { id: task.id },
        data: { status: 'cancelled', finishedAt: new Date() },
    });
    logger.info({ taskId: task.id, userId, from: task.status }, 'Analysis task cancelled');
    return updated;
}

/** 失败或已取消的任务重新入队（任务图片仍在时才可重试） */
export async function retryAnalysisTask(userId: string, taskId: string): Promise<AnalysisTask | null> {
    const task = await getAnalysisTask(userId, taskId);
    if (!task) return null;
    if (task.status !== 'failed' && task.status !== 'cancelled') return task;
    if (!task.imagePath || !fs.existsSync(task.imagePath)) {
        throw new Error('TASK_IMAGE_MISSING');
    }
    const updated = await prisma.analysisTask.update({
        where: { id: task.id },
        data: {
            status: 'queued',
            errorItemId: null,
            errorMessage: null,
            startedAt: null,
            finishedAt: null,
        },
    });
    logger.info({ taskId: task.id, userId, from: task.status }, 'Analysis task requeued');
    kickAnalysisQueue();
    return updated;
}

/**
 * 进程重启后遗留的 processing 任务重置为 queued 重新排队：
 * 单进程部署下，worker 首次启动时仍处于 processing 的任务必然是上个进程中断的。
 */
export async function resetStaleAnalysisTasks(): Promise<number> {
    const result = await prisma.analysisTask.updateMany({
        where: { status: 'processing' },
        data: { status: 'queued', startedAt: null },
    });
    if (result.count > 0) {
        logger.info({ count: result.count }, 'Reset interrupted analysis tasks to queued');
    }
    return result.count;
}

// 开发环境热更新会重新加载模块，队列状态挂在 globalThis 上保持单例
const queueStore = globalThis as typeof globalThis & {
    __analysisQueueRunning?: boolean;
    __analysisQueueRecovered?: boolean;
};

/** 仅供测试：重置队列运行状态（模拟进程重启后的首次启动） */
export function resetAnalysisQueueForTest(): void {
    queueStore.__analysisQueueRunning = false;
    queueStore.__analysisQueueRecovered = false;
}

/** 触发队列处理（已有 worker 在跑时直接返回）；供入队、重试和服务启动时调用 */
export function kickAnalysisQueue(): void {
    if (queueStore.__analysisQueueRunning) return;
    queueStore.__analysisQueueRunning = true;
    void drainAnalysisQueue()
        .catch((error) => logger.error({ error: getErrorMessage(error) }, 'Analysis queue worker crashed'))
        .finally(() => {
            queueStore.__analysisQueueRunning = false;
        });
}

/**
 * 逐个处理排队任务（单并发 FIFO）：识别不设超时，直到队列清空。
 * 路由侧用 kickAnalysisQueue 触发；测试可直接 await 本函数等待处理完成。
 */
export async function drainAnalysisQueue(): Promise<void> {
    if (!queueStore.__analysisQueueRecovered) {
        queueStore.__analysisQueueRecovered = true;
        await resetStaleAnalysisTasks();
    }
    for (;;) {
        const next = await prisma.analysisTask.findFirst({
            where: { status: 'queued' },
            orderBy: { createdAt: 'asc' },
        });
        if (!next) return;
        // 原子领取：只有仍处于 queued 时才置为 processing，被取消/被其它路径处理时跳过
        const claimed = await prisma.analysisTask.updateMany({
            where: { id: next.id, status: 'queued' },
            data: { status: 'processing', startedAt: new Date() },
        });
        if (claimed.count === 0) continue;
        await processAnalysisTask(next.id);
    }
}

/** 处理单个任务：识别 → （未取消时）自动建题 → 写回结果 */
async function processAnalysisTask(taskId: string): Promise<void> {
    const task = await prisma.analysisTask.findUnique({ where: { id: taskId } });
    if (!task || task.status !== 'processing') return;

    try {
        const user = await prisma.user.findUnique({
            where: { id: task.userId },
            select: { id: true, role: true, educationStage: true, enrollmentYear: true, gradeRecognitionMode: true, fixedGradeSemester: true },
        });
        if (!user) throw new Error('USER_NOT_FOUND');

        const imageBuffer = await fs.promises.readFile(task.imagePath);
        const imageBase64 = imageBuffer.toString('base64');

        // 指定了错题本时，按错题本的学段 + 学科取候选知识点（与同步识别一致）
        let subjectChinese: string | null = null;
        let candidateTags: CandidateTags | undefined;
        if (task.notebookId) {
            const notebook = await prisma.subject.findUnique({
                where: { id: task.notebookId },
                select: { name: true, userId: true, stage: true, subjectKey: true, tagSet: true },
            });
            if (notebook && notebook.userId === user.id) {
                const scope = resolveNotebookScope(notebook);
                subjectChinese = scope.subject ? SUBJECT_DISPLAY_NAMES[scope.subject] : null;
                candidateTags = await getNotebookCandidateTags(scope, notebook.tagSet || 'default');
            }
        }

        const limited = await consumeAiQuota(user, 'analyze');
        if (limited) throw new Error(ErrorCode.AI_DAILY_LIMIT_EXCEEDED);

        const context = getQuestionGradeContext(user, getAppTimeZone());
        const language: 'zh' | 'en' = task.language === 'en' ? 'en' : 'zh';
        // 队列不设处理超时：等 AI 完整返回为止；期间用户取消时，结果返回后按状态丢弃
        const analysis = await getAIService().analyzeImage(
            imageBase64,
            task.mimeType,
            language,
            context.grade,
            subjectChinese,
            context.gradeSemester,
            candidateTags,
        );

        // AI 调用期间可能已被取消：重新读取状态，已取消则丢弃结果、绝不建题
        const fresh = await prisma.analysisTask.findUnique({ where: { id: taskId }, select: { status: true } });
        if (!fresh || fresh.status !== 'processing') {
            logger.info({ taskId }, 'Analysis task no longer processing, result discarded');
            return;
        }

        const imported = await importAnalyzedQuestion(user, {
            questionText: analysis.questionText,
            answerText: analysis.answerText,
            analysis: analysis.analysis,
            wrongAnswerText: analysis.wrongAnswerText || null,
            mistakeAnalysis: analysis.mistakeAnalysis || null,
            mistakeStatus: analysis.mistakeStatus || 'unknown',
            knowledgePoints: analysis.knowledgePoints || [],
            originalImageUrl: `data:${task.mimeType};base64,${imageBase64}`,
            subjectId: task.notebookId || undefined,
            subjectName: task.notebookId ? undefined : analysis.subject,
            recognizedGradeSemester: analysis.gradeSemester ?? null,
            difficultyStars: analysis.difficultyStars ?? null,
            hasFigure: analysis.hasFigure ?? false,
            figureSvg: analysis.figureSvg ?? null,
        });

        const finished = await prisma.analysisTask.updateMany({
            where: { id: taskId, status: 'processing' },
            data: {
                status: 'done',
                errorItemId: imported.id,
                resultSubject: analysis.subject,
                resultSummary: describeQuestion({ questionText: analysis.questionText }),
                errorMessage: null,
                finishedAt: new Date(),
            },
        });
        if (finished.count > 0) {
            // 识别结果已存入错题（原图为 data URL），任务图片删除释放空间
            deleteTaskImage(task.imagePath);
            logger.info({ taskId, errorItemId: imported.id, duplicate: imported.duplicate }, 'Analysis task done');
        }
    } catch (error) {
        const message = normalizeTaskError(error);
        // 仅当任务仍在处理中时才标记失败；已被取消的保持已取消状态
        const updated = await prisma.analysisTask.updateMany({
            where: { id: taskId, status: 'processing' },
            data: { status: 'failed', errorMessage: message, finishedAt: new Date() },
        });
        if (updated.count > 0) {
            logger.error({ taskId, error: message }, 'Analysis task failed');
        }
    }
}
