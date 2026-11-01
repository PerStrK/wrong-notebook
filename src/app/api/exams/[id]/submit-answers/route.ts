import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/current-user";
import { unauthorized, notFound, validationError, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { submitExamAnswers } from "@/lib/exam";
import { scheduleMasteryEvaluation } from "@/lib/mastery";
import { withRecoverableResponse } from "@/lib/recoverable-response";

const logger = createLogger('api:exams:submit-answers');

const submitSchema = z.object({
    answers: z.array(z.object({
        questionId: z.string().min(1),
        // 允许空字符串，表示该题未作答
        answer: z.string().max(5000),
    })).min(1).max(100),
    language: z.enum(['zh', 'en']).optional(),
});

/**
 * POST /api/exams/:id/submit-answers
 * 在线作答交卷：逐题由 AI 对照标准答案批改（单题失败或额度用尽时用归一化比对兜底），
 * 结果写入原题的举一反三记录并触发掌握概率重新评估，响应中带成绩汇总
 */
async function handlePost(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    try {
        const user = await getCurrentUser();
        if (!user) {
            return unauthorized("Authentication required");
        }

        const parsed = submitSchema.safeParse(await req.json());
        if (!parsed.success) {
            return validationError("Invalid exam answers", parsed.error.issues);
        }

        const outcome = await submitExamAnswers(id, user, parsed.data.answers, parsed.data.language);
        scheduleMasteryEvaluation(outcome.affected);

        return NextResponse.json({
            results: outcome.results,
            skipped: outcome.skipped,
            score: outcome.score,
        });
    } catch (error) {
        if (error instanceof Error && error.message === 'EXAM_NOT_FOUND') {
            return notFound("Exam paper not found");
        }
        logger.error({ error }, 'Error submitting exam answers');
        return internalError("Failed to submit exam answers");
    }
}

/** 耗时 AI 请求：整卷逐题批改较慢，浏览器中断连接后前端可通过 /api/requests/:id 取回响应 */
export const POST = withRecoverableResponse(handlePost);
