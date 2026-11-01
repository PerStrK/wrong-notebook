// @vitest-environment node
/**
 * 后台识别队列 API 集成测试：真实临时 SQLite 数据库 + mock AI 服务。
 * 覆盖入队接口、列表归属、自动建题（按学科新建错题本 / 指定错题本）、取消他人任务被拒、失败重试。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    analyzeImage: vi.fn(),
    scheduleMasteryEvaluation: vi.fn(),
    session: { user: { id: 'user-1', email: 'queue-test@example.com', role: 'admin' }, expires: '2099-01-01' },
}));

vi.mock('@/lib/prisma', () => ({ get prisma() { return mocks.prisma; } }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/ai', () => ({ getAIService: () => ({ analyzeImage: mocks.analyzeImage, recognizeGrade: vi.fn(async () => null) }) }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/mastery', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/mastery')>()),
    scheduleMasteryEvaluation: mocks.scheduleMasteryEvaluation,
}));
vi.mock('@/lib/paper-level', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/paper-level')>()),
    ensureDefaultPaperGroups: vi.fn(async (userId: string, client?: unknown) => {
        const db = (client ?? mocks.prisma!) as PrismaClient;
        const existing = await db.paperGroup.findMany({ where: { userId } });
        const map: Record<string, string> = {};
        for (const g of existing) {
            if (g.key) map[g.key] = g.id;
        }
        const defaults: Array<{ key: string; name: string; order: number }> = [
            { key: 'a', name: 'A卷', order: 0 },
            { key: 'b', name: 'B卷', order: 1 },
            { key: 'other', name: '其他', order: 2 },
        ];
        for (const d of defaults) {
            if (!map[d.key]) {
                const created = await db.paperGroup.create({
                    data: { userId, key: d.key, name: d.name, order: d.order },
                });
                map[d.key] = created.id;
            }
        }
        return map;
    }),
    getDefaultPaperLevelGroupId: vi.fn(async () => null),
}));

import { GET as LIST_TASKS, POST as CREATE_TASK } from '@/app/api/analysis-tasks/route';
import { POST as CANCEL_TASK } from '@/app/api/analysis-tasks/[id]/cancel/route';
import { POST as RETRY_TASK } from '@/app/api/analysis-tasks/[id]/retry/route';
import { resetAnalysisQueueForTest } from '@/lib/analysis-queue';

let database: PrismaClient;
let directory: string;

const parsed = {
    questionText: '下列关于细胞分化的说法正确的是？',
    answerText: 'B',
    analysis: '细胞分化使细胞形态功能专门化。',
    wrongAnswerText: '',
    mistakeAnalysis: '',
    mistakeStatus: 'unknown',
    subject: '生物',
    knowledgePoints: ['细胞分化'],
    gradeSemester: '初一上',
    difficultyStars: 2,
    hasFigure: false,
    figureSvg: null,
};

function uploadRequest(extra: Record<string, string> = {}): Request {
    const form = new FormData();
    form.append('image', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'question.jpg', { type: 'image/jpeg' }));
    for (const [key, value] of Object.entries(extra)) form.append(key, value);
    return new Request('http://localhost/api/analysis-tasks', { method: 'POST', body: form });
}

async function waitForTaskStatus(taskId: string, status: string): Promise<void> {
    await vi.waitFor(async () => {
        const task = await database.analysisTask.findUnique({ where: { id: taskId } });
        expect(task?.status).toBe(status);
    }, { timeout: 15000, interval: 50 });
}

beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'wrong-notebook-analysis-task-test-'));
    const url = `file:${join(directory, 'test.db')}`;
    process.env.DATABASE_URL = url;
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
    });
    database = new PrismaClient({ datasources: { db: { url } } });
    await database.$queryRaw`PRAGMA journal_mode = WAL`;
    await database.$queryRaw`PRAGMA busy_timeout = 30000`;
    mocks.prisma = database;
    resetAnalysisQueueForTest();
}, 120000);

beforeEach(async () => {
    vi.clearAllMocks();
    mocks.analyzeImage.mockResolvedValue(parsed);
    await database.analysisTask.deleteMany();
    await database.errorItem.deleteMany();
    await database.subject.deleteMany();
    await database.user.deleteMany();
    await database.user.createMany({
        data: [
            { id: 'user-1', email: mocks.session.user.email, password: 'test-only', role: 'admin', gradeRecognitionMode: 'fixed', fixedGradeSemester: '初一上' },
            { id: 'user-2', email: 'other-queue-test@example.com', password: 'test-only' },
        ],
    });
}, 30000);

afterAll(async () => {
    await database.$disconnect();
    rmSync(directory, { recursive: true, force: true });
});

describe('/api/analysis-tasks 后台识别队列', () => {
    it('入队立即返回，识别完成后自动建题并按学科新建错题本', async () => {
        const response = await CREATE_TASK(uploadRequest());
        expect(response.status).toBe(201);
        const { task } = await response.json() as { task: { id: string; status: string } };
        expect(['queued', 'processing']).toContain(task.status);

        await waitForTaskStatus(task.id, 'done');

        const saved = await database.analysisTask.findUnique({ where: { id: task.id } });
        expect(saved?.errorItemId).toBeTruthy();
        expect(saved?.resultSubject).toBe('生物');
        expect(saved?.imagePath && existsSync(saved.imagePath)).toBe(false);

        const item = await database.errorItem.findUnique({ where: { id: saved!.errorItemId! } });
        expect(item?.questionText).toBe(parsed.questionText);
        expect(item?.originalImageUrl).toContain('data:image/jpeg;base64,');
        const notebook = await database.subject.findFirst({ where: { userId: 'user-1', name: '生物' } });
        expect(notebook).toBeTruthy();
        expect(item?.subjectId).toBe(notebook!.id);
    });

    it('指定错题本时题目进入该错题本', async () => {
        const notebook = await database.subject.create({
            data: { id: 'nb-bio', name: '生物错题', userId: 'user-1', stage: 'junior_high', subjectKey: 'biology' },
        });
        const response = await CREATE_TASK(uploadRequest({ notebookId: notebook.id }));
        expect(response.status).toBe(201);
        const { task } = await response.json() as { task: { id: string; subjectHint: string | null } };
        expect(task.subjectHint).toBe('生物错题');

        await waitForTaskStatus(task.id, 'done');
        const saved = await database.analysisTask.findUnique({ where: { id: task.id } });
        const item = await database.errorItem.findUnique({ where: { id: saved!.errorItemId! } });
        expect(item?.subjectId).toBe(notebook.id);
    });

    it('指定他人错题本时返回 404', async () => {
        const foreign = await database.subject.create({
            data: { id: 'nb-foreign', name: '他人错题本', userId: 'user-2' },
        });
        const response = await CREATE_TASK(uploadRequest({ notebookId: foreign.id }));
        expect(response.status).toBe(404);
        expect(await database.analysisTask.count()).toBe(0);
    });

    it('缺少图片或类型不支持时返回 400', async () => {
        const empty = await CREATE_TASK(new Request('http://localhost/api/analysis-tasks', { method: 'POST', body: new FormData() }));
        expect(empty.status).toBe(400);

        const form = new FormData();
        form.append('image', new File([new Uint8Array([1])], 'note.txt', { type: 'text/plain' }));
        const wrongType = await CREATE_TASK(new Request('http://localhost/api/analysis-tasks', { method: 'POST', body: form }));
        expect(wrongType.status).toBe(400);
    });

    it('任务列表只包含自己的任务', async () => {
        await database.analysisTask.create({
            data: { userId: 'user-2', status: 'done', imagePath: '/nonexistent.jpg', mimeType: 'image/jpeg' },
        });
        const own = await CREATE_TASK(uploadRequest());
        const { task } = await own.json() as { task: { id: string } };
        await waitForTaskStatus(task.id, 'done');

        const response = await LIST_TASKS();
        const { tasks } = await response.json() as { tasks: Array<{ id: string }> };
        expect(tasks.map((entry) => entry.id)).toEqual([task.id]);
    });

    it('取消他人的任务返回 404 且任务不变', async () => {
        const foreign = await database.analysisTask.create({
            data: { userId: 'user-2', status: 'queued', imagePath: '/nonexistent.jpg', mimeType: 'image/jpeg' },
        });
        const response = await CANCEL_TASK(
            new Request(`http://localhost/api/analysis-tasks/${foreign.id}/cancel`, { method: 'POST' }),
            { params: Promise.resolve({ id: foreign.id }) },
        );
        expect(response.status).toBe(404);
        const after = await database.analysisTask.findUnique({ where: { id: foreign.id } });
        expect(after?.status).toBe('queued');
    });

    it('识别失败记录原因，重试后成功建题', async () => {
        mocks.analyzeImage.mockRejectedValueOnce(new Error('AI_SERVICE_UNAVAILABLE'));
        const response = await CREATE_TASK(uploadRequest());
        const { task } = await response.json() as { task: { id: string } };
        await waitForTaskStatus(task.id, 'failed');
        const failed = await database.analysisTask.findUnique({ where: { id: task.id } });
        expect(failed?.errorMessage).toBe('AI_SERVICE_UNAVAILABLE');
        expect(await database.errorItem.count()).toBe(0);

        const retryResponse = await RETRY_TASK(
            new Request(`http://localhost/api/analysis-tasks/${task.id}/retry`, { method: 'POST' }),
            { params: Promise.resolve({ id: task.id }) },
        );
        expect(retryResponse.status).toBe(200);
        await waitForTaskStatus(task.id, 'done');
        expect(await database.errorItem.count()).toBe(1);
    });
});
