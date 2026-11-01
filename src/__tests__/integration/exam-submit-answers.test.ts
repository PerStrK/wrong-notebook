/**
 * /api/exams/:id/submit-answers 在线作答批改 API 集成测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
    const tx = {
        practiceRecord: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
        examQuestion: { update: vi.fn() },
        examPaper: { update: vi.fn() },
    };
    return {
        tx,
        user: { findUnique: vi.fn() },
        examPaper: { findUnique: vi.fn() },
        transaction: vi.fn(async (arg: ((client: typeof tx) => Promise<unknown>) | Promise<unknown>[]) => (
            Array.isArray(arg) ? Promise.all(arg) : arg(tx)
        )),
        gradeAnswer: vi.fn(),
        consumeAiQuota: vi.fn(),
        scheduleMasteryEvaluation: vi.fn(),
        session: { user: { email: 'user@example.com' }, expires: '2099-01-01' },
    };
});

vi.mock('@/lib/prisma', () => ({
    prisma: {
        user: mocks.user,
        examPaper: mocks.examPaper,
        $transaction: mocks.transaction,
    },
}));
vi.mock('@/lib/ai', () => ({ getAIService: vi.fn(() => ({ gradeAnswer: mocks.gradeAnswer })) }));
vi.mock('@/lib/ai-quota', () => ({ consumeAiQuota: mocks.consumeAiQuota }));
vi.mock('@/lib/mastery', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/mastery')>()),
    scheduleMasteryEvaluation: mocks.scheduleMasteryEvaluation,
}));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(() => Promise.resolve(mocks.session)) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/config', () => ({ getAppTimeZone: vi.fn(() => 'Asia/Shanghai') }));

import { POST as SUBMIT } from '@/app/api/exams/[id]/submit-answers/route';

const json = (body: object) => new Request('http://localhost', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const paper = {
    userId: 'user-1',
    difficulty: 'medium',
    questions: [
        { id: 'q1', order: 1, status: 'ready', errorItemId: 'e1', questionText: '题1', answerText: 'A', analysis: '解1', figureSvg: null, errorItem: { subject: { name: '数学' } } },
        { id: 'q2', order: 2, status: 'ready', errorItemId: 'e2', questionText: '题2', answerText: 'B', analysis: '解2', figureSvg: null, errorItem: { subject: { name: '数学' } } },
        { id: 'q3', order: 3, status: 'ready', errorItemId: 'e3', questionText: '题3', answerText: 'C', analysis: '解3', figureSvg: null, errorItem: null },
    ],
};

describe('POST /api/exams/:id/submit-answers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.findUnique.mockResolvedValue({ id: 'user-1', role: 'user' });
        mocks.examPaper.findUnique.mockResolvedValue(paper);
        mocks.consumeAiQuota.mockResolvedValue(null);
        // 默认判分：与标准答案相同判对，否则判错
        mocks.gradeAnswer.mockImplementation(async (input: { answerText: string; userAnswer: string }) => (
            input.userAnswer === input.answerText
                ? { correct: true, reason: '与标准答案一致' }
                : { correct: false, reason: '与标准答案不一致' }
        ));
    });

    it('逐题 AI 批改并落库：对、错、未答分别记 correct/wrong/not_attempted', async () => {
        const response = await SUBMIT(json({
            answers: [
                { questionId: 'q1', answer: 'A' },
                { questionId: 'q2', answer: 'X' },
                { questionId: 'q3', answer: '  ' },
            ],
            language: 'zh',
        }), params('p1'));

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.results).toEqual([
            { questionId: 'q1', result: 'correct', feedback: '与标准答案一致', correctAnswer: 'A' },
            { questionId: 'q2', result: 'wrong', feedback: '与标准答案不一致', correctAnswer: 'B' },
            { questionId: 'q3', result: 'not_attempted', feedback: '', correctAnswer: 'C' },
        ]);
        expect(body.skipped).toEqual([]);
        expect(body.score).toEqual({ total: 3, answered: 2, correct: 1, rate: 0.33 });

        // 未答题不调用 AI；已答题按 exam 记额度
        expect(mocks.gradeAnswer).toHaveBeenCalledTimes(2);
        expect(mocks.consumeAiQuota).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-1' }), 'exam');

        // 每题一条试卷来源记录，学生答案与 AI 批语都存快照
        expect(mocks.tx.practiceRecord.create).toHaveBeenCalledTimes(3);
        expect(mocks.tx.practiceRecord.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: 'user-1',
                errorItemId: 'e1',
                examQuestionId: 'q1',
                source: 'exam',
                result: 'correct',
                isCorrect: true,
                wrongAnswerText: 'A',
                mistakeAnalysis: '与标准答案一致',
            }),
        });
        expect(mocks.tx.practiceRecord.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                examQuestionId: 'q3',
                result: 'not_attempted',
                isCorrect: false,
                wrongAnswerText: null,
                mistakeAnalysis: null,
            }),
        });
        expect(mocks.tx.examPaper.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { resultsRecordedAt: expect.any(Date) } });
        expect(mocks.scheduleMasteryEvaluation).toHaveBeenCalledWith(['e1', 'e2', 'e3']);
    });

    it('未生成完成或缺少标准答案的题目跳过批改并在响应中标注', async () => {
        mocks.examPaper.findUnique.mockResolvedValue({
            ...paper,
            questions: [
                ...paper.questions,
                { id: 'q4', order: 4, status: 'pending', errorItemId: 'e4', questionText: null, answerText: null, analysis: null, figureSvg: null, errorItem: null },
                { id: 'q5', order: 5, status: 'ready', errorItemId: 'e5', questionText: '题5', answerText: '  ', analysis: null, figureSvg: null, errorItem: null },
            ],
        });

        const response = await SUBMIT(json({ answers: [{ questionId: 'q1', answer: 'A' }] }), params('p1'));

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.skipped).toEqual(['q4', 'q5']);
        expect(body.score.total).toBe(3);
        expect(mocks.tx.practiceRecord.create).toHaveBeenCalledTimes(3);
        expect(mocks.tx.practiceRecord.create).not.toHaveBeenCalledWith({
            data: expect.objectContaining({ examQuestionId: 'q4' }),
        });
    });

    it('AI 批改失败时用归一化比对兜底（忽略大小写与标点）', async () => {
        mocks.gradeAnswer.mockRejectedValue(new Error('AI_TIMEOUT_ERROR'));

        const response = await SUBMIT(json({
            answers: [
                { questionId: 'q1', answer: 'a。' },
                { questionId: 'q2', answer: 'Y' },
            ],
        }), params('p1'));

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.results[0]).toMatchObject({ questionId: 'q1', result: 'correct' });
        expect(body.results[0].feedback).toContain('归一化比对');
        expect(body.results[1]).toMatchObject({ questionId: 'q2', result: 'wrong' });
        // 兜底结果同样落库，批语注明是比对判定
        expect(mocks.tx.practiceRecord.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ examQuestionId: 'q1', result: 'correct', mistakeAnalysis: expect.stringContaining('归一化比对') }),
        });
    });

    it('他人的试卷返回 404，不批改不落库', async () => {
        mocks.examPaper.findUnique.mockResolvedValue({ ...paper, userId: 'other' });

        const response = await SUBMIT(json({ answers: [{ questionId: 'q1', answer: 'A' }] }), params('p1'));

        expect(response.status).toBe(404);
        expect(mocks.gradeAnswer).not.toHaveBeenCalled();
        expect(mocks.tx.practiceRecord.create).not.toHaveBeenCalled();
        expect(mocks.scheduleMasteryEvaluation).not.toHaveBeenCalled();
    });

    it('请求体不合法时返回 400', async () => {
        expect((await SUBMIT(json({ answers: [] }), params('p1'))).status).toBe(400);
        expect((await SUBMIT(json({ answers: [{ questionId: '', answer: 'A' }] }), params('p1'))).status).toBe(400);
        expect(mocks.gradeAnswer).not.toHaveBeenCalled();
    });
});
