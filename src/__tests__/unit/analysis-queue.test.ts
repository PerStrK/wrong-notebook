// @vitest-environment node
/**
 * 后台识别队列状态机单元测试：内存版 Prisma 假实现 + mock AI，
 * 覆盖入队→处理→建题、排队中取消、识别中取消丢弃结果、失败记录、重试、重启恢复。
 */
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeTask {
    id: string;
    userId: string;
    status: string;
    imagePath: string;
    mimeType: string;
    notebookId: string | null;
    subjectHint: string | null;
    language: string;
    errorItemId: string | null;
    resultSubject: string | null;
    resultSummary: string | null;
    errorMessage: string | null;
    createdAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
}

function matches(task: FakeTask, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) => (task as unknown as Record<string, unknown>)[key] === value);
}

const mocks = vi.hoisted(() => ({
    tasks: new Map<string, FakeTask>(),
    sequence: 0,
    analyzeImage: vi.fn(),
    importAnalyzedQuestion: vi.fn(),
    consumeAiQuota: vi.fn(async () => null),
}));

const fakePrisma = vi.hoisted(() => ({
    analysisTask: {
        create: vi.fn(async ({ data }: { data: Omit<FakeTask, 'id' | 'createdAt' | 'startedAt' | 'finishedAt' | 'errorItemId' | 'resultSubject' | 'resultSummary' | 'errorMessage'> }) => {
            const task: FakeTask = {
                ...data,
                id: `task-${++mocks.sequence}`,
                errorItemId: null,
                resultSubject: null,
                resultSummary: null,
                errorMessage: null,
                createdAt: new Date(Date.now() + mocks.sequence),
                startedAt: null,
                finishedAt: null,
            };
            mocks.tasks.set(task.id, task);
            return task;
        }),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => mocks.tasks.get(where.id) ?? null),
        findFirst: vi.fn(async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: { createdAt: 'asc' | 'desc' } }) => {
            const rows = [...mocks.tasks.values()].filter((task) => matches(task, where));
            rows.sort((a, b) => orderBy?.createdAt === 'desc'
                ? b.createdAt.getTime() - a.createdAt.getTime()
                : a.createdAt.getTime() - b.createdAt.getTime());
            return rows[0] ?? null;
        }),
        findMany: vi.fn(async ({ where, orderBy, take }: { where: Record<string, unknown>; orderBy?: { createdAt: 'asc' | 'desc' }; take?: number }) => {
            const rows = [...mocks.tasks.values()].filter((task) => matches(task, where));
            rows.sort((a, b) => orderBy?.createdAt === 'desc'
                ? b.createdAt.getTime() - a.createdAt.getTime()
                : a.createdAt.getTime() - b.createdAt.getTime());
            return take ? rows.slice(0, take) : rows;
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeTask> }) => {
            const task = mocks.tasks.get(where.id);
            if (!task) throw new Error('not found');
            Object.assign(task, data);
            return task;
        }),
        updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<FakeTask> }) => {
            let count = 0;
            for (const task of mocks.tasks.values()) {
                if (matches(task, where)) {
                    Object.assign(task, data);
                    count++;
                }
            }
            return { count };
        }),
        delete: vi.fn(async ({ where }: { where: { id: string } }) => {
            const task = mocks.tasks.get(where.id);
            mocks.tasks.delete(where.id);
            return task;
        }),
    },
    user: {
        findUnique: vi.fn(async () => ({
            id: 'user-1',
            role: 'admin',
            educationStage: 'junior_high',
            enrollmentYear: 2025,
            gradeRecognitionMode: 'fixed',
            fixedGradeSemester: '初一上',
        })),
    },
    subject: {
        findUnique: vi.fn(async () => null),
    },
}));

vi.mock('@/lib/prisma', () => ({ prisma: fakePrisma }));
vi.mock('@/lib/ai', () => ({ getAIService: () => ({ analyzeImage: mocks.analyzeImage }) }));
vi.mock('@/lib/ai-quota', () => ({ consumeAiQuota: mocks.consumeAiQuota }));
vi.mock('@/lib/analysis-import', () => ({ importAnalyzedQuestion: mocks.importAnalyzedQuestion }));
vi.mock('@/lib/ai/tag-service', () => ({ getNotebookCandidateTags: vi.fn(async () => undefined) }));
vi.mock('@/lib/config', () => ({ getAppTimeZone: () => 'Asia/Shanghai' }));

import {
    cancelAnalysisTask,
    drainAnalysisQueue,
    enqueueAnalysisTask,
    getAnalysisTask,
    getAnalysisTaskDir,
    resetAnalysisQueueForTest,
    retryAnalysisTask,
} from '@/lib/analysis-queue';

const parsed = {
    questionText: '下列关于细胞的说法正确的是？',
    answerText: 'A',
    analysis: '解析内容',
    wrongAnswerText: '',
    mistakeAnalysis: '',
    mistakeStatus: 'unknown',
    subject: '生物',
    knowledgePoints: ['细胞'],
    gradeSemester: '初一上',
    difficultyStars: 2,
    hasFigure: false,
    figureSvg: null,
};

let directory: string;

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function waitForStatus(taskId: string, status: string): Promise<void> {
    await vi.waitFor(async () => {
        const task = await getAnalysisTask('user-1', taskId);
        expect(task?.status).toBe(status);
    }, { timeout: 5000, interval: 20 });
}

beforeEach(() => {
    mocks.tasks.clear();
    mocks.sequence = 0;
    vi.clearAllMocks();
    mocks.consumeAiQuota.mockResolvedValue(null);
    mocks.analyzeImage.mockResolvedValue(parsed);
    mocks.importAnalyzedQuestion.mockResolvedValue({ id: 'item-1', duplicate: false });
    resetAnalysisQueueForTest();
    directory = mkdtempSync(join(tmpdir(), 'analysis-queue-test-'));
    process.env.DATABASE_URL = `file:${join(directory, 'test.db')}`;
});

afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('后台识别队列', () => {
    it('入队后自动识别并建题，任务置 done 且删除任务图片', async () => {
        const task = await enqueueAnalysisTask({
            userId: 'user-1',
            image: Buffer.from('fake-image'),
            mimeType: 'image/jpeg',
        });
        expect(fs.existsSync(task.imagePath)).toBe(true);

        await drainAnalysisQueue();

        const saved = await getAnalysisTask('user-1', task.id);
        expect(saved?.status).toBe('done');
        expect(saved?.errorItemId).toBe('item-1');
        expect(saved?.resultSubject).toBe('生物');
        expect(mocks.importAnalyzedQuestion).toHaveBeenCalledTimes(1);
        const importInput = mocks.importAnalyzedQuestion.mock.calls[0][1];
        expect(importInput.originalImageUrl).toContain('data:image/jpeg;base64,');
        expect(importInput.subjectName).toBe('生物');
        expect(fs.existsSync(task.imagePath)).toBe(false);
    });

    it('排队中的任务可取消，之后不会被处理', async () => {
        const gate = deferred<typeof parsed>();
        mocks.analyzeImage.mockReturnValueOnce(gate.promise);

        const first = await enqueueAnalysisTask({ userId: 'user-1', image: Buffer.from('a'), mimeType: 'image/png' });
        await waitForStatus(first.id, 'processing');
        const second = await enqueueAnalysisTask({ userId: 'user-1', image: Buffer.from('b'), mimeType: 'image/png' });

        const cancelled = await cancelAnalysisTask('user-1', second.id);
        expect(cancelled?.status).toBe('cancelled');

        gate.resolve(parsed);
        await drainAnalysisQueue();

        expect((await getAnalysisTask('user-1', first.id))?.status).toBe('done');
        expect((await getAnalysisTask('user-1', second.id))?.status).toBe('cancelled');
        expect(mocks.importAnalyzedQuestion).toHaveBeenCalledTimes(1);
    });

    it('识别中的任务取消后，AI 结果被丢弃、绝不建题', async () => {
        const gate = deferred<typeof parsed>();
        mocks.analyzeImage.mockReturnValueOnce(gate.promise);

        const task = await enqueueAnalysisTask({ userId: 'user-1', image: Buffer.from('a'), mimeType: 'image/jpeg' });
        await waitForStatus(task.id, 'processing');

        await cancelAnalysisTask('user-1', task.id);
        gate.resolve(parsed);
        await drainAnalysisQueue();

        expect((await getAnalysisTask('user-1', task.id))?.status).toBe('cancelled');
        expect(mocks.importAnalyzedQuestion).not.toHaveBeenCalled();
    });

    it('AI 失败时任务置 failed 并记录错误码', async () => {
        mocks.analyzeImage.mockRejectedValueOnce(new Error('AI_CONNECTION_FAILED'));
        const task = await enqueueAnalysisTask({ userId: 'user-1', image: Buffer.from('a'), mimeType: 'image/jpeg' });

        await drainAnalysisQueue();

        const saved = await getAnalysisTask('user-1', task.id);
        expect(saved?.status).toBe('failed');
        expect(saved?.errorMessage).toBe('AI_CONNECTION_FAILED');
        expect(mocks.importAnalyzedQuestion).not.toHaveBeenCalled();
    });

    it('失败任务重试后重新识别并建题', async () => {
        mocks.analyzeImage.mockRejectedValueOnce(new Error('AI_TIMEOUT_ERROR'));
        const task = await enqueueAnalysisTask({ userId: 'user-1', image: Buffer.from('a'), mimeType: 'image/jpeg' });
        await drainAnalysisQueue();
        expect((await getAnalysisTask('user-1', task.id))?.status).toBe('failed');

        const retried = await retryAnalysisTask('user-1', task.id);
        // 重试会立即触发队列处理，返回时可能已被领取进入识别中
        expect(['queued', 'processing']).toContain(retried?.status);
        expect(retried?.errorMessage).toBeNull();
        await waitForStatus(task.id, 'done');

        expect(mocks.importAnalyzedQuestion).toHaveBeenCalledTimes(1);
    });

    it('进程重启后遗留的 processing 任务被重置并继续处理', async () => {
        // 直接构造一条上个进程遗留的 processing 任务（图片文件还在），不经入队触发
        const dir = getAnalysisTaskDir();
        await fs.promises.mkdir(dir, { recursive: true });
        const imagePath = join(dir, 'legacy-task.jpg');
        await fs.promises.writeFile(imagePath, Buffer.from('a'));
        const task = await fakePrisma.analysisTask.create({
            data: {
                userId: 'user-1',
                status: 'queued',
                imagePath,
                mimeType: 'image/jpeg',
                notebookId: null,
                subjectHint: null,
                language: 'zh',
            },
        });
        await fakePrisma.analysisTask.update({ where: { id: task.id }, data: { status: 'processing', startedAt: new Date() } });
        resetAnalysisQueueForTest();

        await drainAnalysisQueue();

        expect((await getAnalysisTask('user-1', task.id))?.status).toBe('done');
        expect(mocks.importAnalyzedQuestion).toHaveBeenCalledTimes(1);
    });

    it('他人任务不可见、不可取消', async () => {
        const task = await enqueueAnalysisTask({ userId: 'user-1', image: Buffer.from('a'), mimeType: 'image/jpeg' });
        expect(await getAnalysisTask('user-2', task.id)).toBeNull();
        expect(await cancelAnalysisTask('user-2', task.id)).toBeNull();
        await drainAnalysisQueue();
    });
});
