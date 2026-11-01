import { apiClient } from "@/lib/api-client";
import type { AnalysisTaskItem } from "@/types/api";

/** 后台识别队列的前端调用封装 */

/** 把一张图片加入后台识别队列：只上传图片，识别在后台进行，立即返回任务 */
export async function enqueueAnalysisImage(
    image: Blob,
    options: { notebookId?: string | null; language: 'zh' | 'en' },
): Promise<AnalysisTaskItem> {
    const form = new FormData();
    const ext = image.type === 'image/png' ? 'png' : image.type === 'image/webp' ? 'webp' : 'jpg';
    form.append('image', image, `question.${ext}`);
    if (options.notebookId) form.append('notebookId', options.notebookId);
    form.append('language', options.language);

    const res = await fetch('/api/analysis-tasks', { method: 'POST', body: form });
    if (!res.ok) {
        throw new Error(`Enqueue failed: ${res.status}`);
    }
    const data = await res.json() as { task: AnalysisTaskItem };
    return data.task;
}

/** 当前用户的识别任务列表（倒序） */
export async function fetchAnalysisTasks(): Promise<AnalysisTaskItem[]> {
    const data = await apiClient.get<{ tasks: AnalysisTaskItem[] }>('/api/analysis-tasks');
    return data.tasks;
}

/** 取消排队中或识别中的任务 */
export async function cancelAnalysisTask(taskId: string): Promise<void> {
    await apiClient.post(`/api/analysis-tasks/${taskId}/cancel`, {});
}

/** 失败或已取消的任务重新入队 */
export async function retryAnalysisTask(taskId: string): Promise<void> {
    await apiClient.post(`/api/analysis-tasks/${taskId}/retry`, {});
}

/** 任务是否有未结束（排队/识别中）的，用于决定是否继续轮询 */
export function hasActiveAnalysisTasks(tasks: AnalysisTaskItem[]): boolean {
    return tasks.some((task) => task.status === 'queued' || task.status === 'processing');
}

/** data URL（图片压缩结果）转 Blob，供入队上传 */
export function dataUrlToBlob(dataUrl: string): Blob {
    const [header, base64] = dataUrl.split(',');
    const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
    const binary = atob(base64 || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
}
