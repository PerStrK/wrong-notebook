"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PageLoading } from "@/components/ui/page-loading";
import { ShortIdLocator } from "@/components/short-id-locator";
import { BookOpen, Plus } from "lucide-react";
import { NotebookCard } from "@/components/notebook-card";
import { CreateNotebookDialog, type CreateNotebookInput } from "@/components/create-notebook-dialog";

import { Notebook } from "@/types/api";
import { apiClient } from "@/lib/api-client";

import { useLanguage } from "@/contexts/LanguageContext";
import { usePageTitle } from "@/lib/page-title";
import { toast } from "@/lib/feedback";
import { frontendLogger } from "@/lib/frontend-logger";
import { getApiErrorMessage } from "@/lib/error-message";

export default function NotebooksPage() {
    const router = useRouter();
    const { t } = useLanguage(); // Use hook
    usePageTitle(t.notebooks.title);
    const [notebooks, setNotebooks] = useState<Notebook[]>([]);
    const [loadError, setLoadError] = useState(false);
    const [loading, setLoading] = useState(true);
    const [dialogOpen, setDialogOpen] = useState(false);

    const fetchNotebooks = useCallback(async () => {
        try {
            const data = await apiClient.get<Notebook[]>("/api/notebooks");
            setNotebooks(data);
            setLoadError(false);
        } catch (error) {
            setLoadError(true);
            frontendLogger.error('[Notebooks]', 'Failed to fetch notebooks', { error });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 数据请求：进入页面或条件变化时加载，请求前后更新加载状态和结果
        fetchNotebooks();
    }, [fetchNotebooks]);

    const handleCreate = async (input: CreateNotebookInput) => {
        try {
            await apiClient.post("/api/notebooks", input);
            await fetchNotebooks();
        } catch (error) {
            frontendLogger.error('[Notebooks]', 'Failed to create notebook', { error });
            const message = getApiErrorMessage(error) || t.notebooks?.createError || "Failed to create";
            toast.error(message);
        }
    };

    const handleNotebookClick = (id: string) => {
        router.push(`/notebooks/${id}`);
    };

    if (loading) {
        return <PageLoading label={t.common.loading} />;
    }

    return (
        <main className="mx-auto min-h-screen max-w-6xl px-4 py-6 md:px-8 md:py-8">
            <div className="space-y-6">
                <PageHeader
                    title={t.notebooks?.title || "My Notebooks"}
                    description={t.notebooks?.subtitle || "Manage your mistakes by subject"}
                    actions={
                        <Button onClick={() => setDialogOpen(true)} aria-label={t.notebooks?.create || "New Notebook"}>
                            <Plus className="h-4 w-4" />
                            <span className="hidden sm:inline">{t.notebooks?.create || "New Notebook"}</span>
                        </Button>
                    }
                />

                <ShortIdLocator />

                {loadError && notebooks.length === 0 ? (
                    <EmptyState
                        icon={BookOpen}
                        title={t.notebooks?.loadError || "Could not load your notebooks"}
                        description={t.notebooks?.loadErrorHint}
                        action={
                            <Button onClick={() => { setLoading(true); fetchNotebooks(); }}>
                                {t.notebooks?.retryLoad || "Retry"}
                            </Button>
                        }
                    />
                ) : notebooks.length === 0 ? (
                    <EmptyState
                        icon={BookOpen}
                        title={t.notebooks?.empty || "No notebooks yet."}
                        action={
                            <Button onClick={() => setDialogOpen(true)}>
                                <Plus className="h-4 w-4" />
                                {t.notebooks?.createFirst || "Create Notebook"}
                            </Button>
                        }
                    />
                ) : (
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {notebooks.map((notebook) => (
                            <NotebookCard
                                key={notebook.id}
                                name={notebook.name}
                                stage={notebook.stage}
                                subjectKey={notebook.subjectKey}
                                errorCount={notebook._count?.errorItems || 0}
                                onClick={() => handleNotebookClick(notebook.id)}
                                itemLabel={t.notebooks.cardItems}
                            />
                        ))}
                    </div>
                )}

                <CreateNotebookDialog
                    key={t.common.loading} // Force re-render when language changes
                    open={dialogOpen}
                    onOpenChange={setDialogOpen}
                    onCreate={handleCreate}
                />

            </div>
        </main>
    );
}
