import { prisma } from "@/lib/prisma";
import { ErrorCode } from "@/lib/api-errors";
import { prepareImportGrade } from "@/lib/import-question-grade";
import { needsQuestionGradeRecognition } from "@/lib/question-grade";
import { createLogger } from "@/lib/logger";
import { findParentTagIdForGrade } from "@/lib/tag-recognition";
import { inferSubjectFromName } from "@/lib/knowledge-tags";
import { normalizeMistakeStatusForSave } from "@/lib/mistake-status";
import { generateUniqueShortId } from "@/lib/short-id";
import { resolveNotebookForSubject } from "@/lib/notebook-resolver";
import { scheduleMasteryEvaluation } from "@/lib/mastery";
import { findDuplicateQuestion, recordDuplicateQuestion, runQuestionImportTransaction } from "@/lib/question-deduplication";
import { MAX_FIGURE_SVG_LENGTH, sanitizeFigureSvg } from "@/lib/figure-svg";
import { getDefaultPaperLevelGroupId, ensureDefaultPaperGroups } from "@/lib/paper-level";
import { DEFAULT_FIGURE_ALIGN, DEFAULT_FIGURE_SCALE } from "@/lib/figure-scale";

const logger = createLogger('analysis-import');

/** 识别结果自动入库所需的题目内容（字段与 POST /api/error-items 的导入参数对齐） */
export interface AnalysisImportInput {
    questionText?: string | null;
    answerText?: string | null;
    analysis?: string | null;
    wrongAnswerText?: string | null;
    mistakeAnalysis?: string | null;
    mistakeStatus?: string | null;
    knowledgePoints?: string[];
    /** 题目原图（data URL），与手动流一致存入错题 */
    originalImageUrl: string;
    /** 指定错题本时传 id；未指定时按 subjectName 自动匹配或新建错题本 */
    subjectId?: string | null;
    subjectName?: string | null;
    /** AI 识别出的年级学期（原始值），最终年级按用户年级规则解析 */
    recognizedGradeSemester?: string | null;
    difficultyStars?: number | null;
    hasFigure?: boolean;
    figureSvg?: string | null;
}

export interface AnalysisImportResult {
    id: string;
    /** true 表示命中重复题，返回的是原题 id（重复作答已记为练习记录） */
    duplicate: boolean;
}

interface ImportUser {
    id: string;
    role?: string | null;
    gradeRecognitionMode: string;
    fixedGradeSemester?: string | null;
    educationStage?: string | null;
    enrollmentYear?: number | null;
}

/**
 * 把 AI 识别结果直接保存为错题，逻辑与 POST /api/error-items 的手动确认流保持一致：
 * 年级解析（含 AI 年级识别的额度处理）、判重、知识点标签、默认卷别、按学科匹配错题本。
 * 年级补充识别遇到每日额度上限时抛出 message 为 AI_DAILY_LIMIT_EXCEEDED 的错误，由调用方处理。
 */
export async function importAnalyzedQuestion(user: ImportUser, input: AnalysisImportInput): Promise<AnalysisImportResult> {
    const figureSvg = sanitizeFigureSvg(input.figureSvg, MAX_FIGURE_SVG_LENGTH);
    const hasFigure = !!input.hasFigure || figureSvg !== null;

    const gradeInput = {
        questionText: input.questionText,
        recognizedGradeSemester: input.recognizedGradeSemester,
    };
    const duplicateBeforeRecognition = needsQuestionGradeRecognition(user, gradeInput)
        ? await findDuplicateQuestion(prisma, user.id, gradeInput) : null;
    const gradeResult = await prepareImportGrade(user, gradeInput, duplicateBeforeRecognition !== null);
    if (gradeResult.response) {
        throw new Error(ErrorCode.AI_DAILY_LIMIT_EXCEEDED);
    }

    const result = await runQuestionImportTransaction(async (tx) => {
        const duplicate = await findDuplicateQuestion(tx, user.id, input);
        if (duplicate) return recordDuplicateQuestion(tx, user.id, duplicate, input);

        // 事务内确保默认分组存在（并发安全），并解析默认卷别
        await ensureDefaultPaperGroups(user.id, tx);
        const paperLevel = await getDefaultPaperLevelGroupId(user.id, input.difficultyStars, tx);

        // 未指定错题本时，按学科名匹配或新建错题本
        let subjectId: string | undefined = input.subjectId || undefined;
        if (!subjectId && typeof input.subjectName === 'string' && input.subjectName.trim()) {
            subjectId = (await resolveNotebookForSubject(user.id, input.subjectName, tx)).id;
        }

        // 处理知识点标签（限定在当前错题本的标签体系内）
        const tagNames: string[] = Array.isArray(input.knowledgePoints) ? input.knowledgePoints : [];
        const tagConnections: { id: string }[] = [];
        const subject = await tx.subject.findUnique({ where: { id: subjectId || '' } });
        const subjectKey = inferSubjectFromName(subject?.name ?? null) || 'other';
        const notebookTagSet = subject?.tagSet || 'default';
        for (const tagName of tagNames) {
            let tag = await tx.knowledgeTag.findFirst({
                where: {
                    name: tagName,
                    tagSet: notebookTagSet,
                    OR: [
                        { isSystem: true },
                        { userId: user.id },
                    ],
                },
            });

            if (!tag) {
                const parentId = await findParentTagIdForGrade(gradeResult.gradeSemester, subjectKey, tx, notebookTagSet);
                tag = await tx.knowledgeTag.create({
                    data: {
                        name: tagName,
                        subject: subjectKey,
                        isSystem: false,
                        userId: user.id,
                        parentId: parentId,
                        tagSet: notebookTagSet,
                    },
                });
            }

            tagConnections.push({ id: tag.id });
        }

        const errorItem = await tx.errorItem.create({
            data: {
                shortId: await generateUniqueShortId(tx),
                userId: user.id,
                subjectId: subjectId || undefined,
                originalImageUrl: input.originalImageUrl,
                questionText: input.questionText,
                answerText: input.answerText,
                analysis: input.analysis,
                wrongAnswerText: input.wrongAnswerText || null,
                mistakeAnalysis: input.mistakeAnalysis || null,
                mistakeStatus: normalizeMistakeStatusForSave(input.mistakeStatus, input.wrongAnswerText),
                knowledgePoints: JSON.stringify(tagNames),
                gradeSemester: gradeResult.gradeSemester,
                paperLevel,
                difficultyStars: input.difficultyStars ?? null,
                hasFigure,
                figureSvg,
                figureScale: DEFAULT_FIGURE_SCALE,
                figureAlign: DEFAULT_FIGURE_ALIGN,
                masteryLevel: 0,
                tags: {
                    connect: tagConnections,
                },
            },
            select: { id: true },
        });

        logger.info({ errorItemId: errorItem.id, userId: user.id, tagsCount: tagConnections.length }, 'Analysis result imported as error item');
        return errorItem;
    });

    const duplicate = 'duplicate' in result && result.duplicate === true;
    if (duplicate) scheduleMasteryEvaluation([result.id]);
    return { id: result.id, duplicate };
}
