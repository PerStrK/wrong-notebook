-- CreateTable
CREATE TABLE "AnalysisTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "imagePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'image/jpeg',
    "notebookId" TEXT,
    "subjectHint" TEXT,
    "language" TEXT NOT NULL DEFAULT 'zh',
    "errorItemId" TEXT,
    "resultSubject" TEXT,
    "resultSummary" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "AnalysisTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AnalysisTask_userId_createdAt_idx" ON "AnalysisTask"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AnalysisTask_status_createdAt_idx" ON "AnalysisTask"("status", "createdAt");
