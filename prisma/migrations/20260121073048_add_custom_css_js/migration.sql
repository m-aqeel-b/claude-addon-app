-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_WidgetStyle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "bundleId" TEXT NOT NULL,
    "template" TEXT NOT NULL DEFAULT 'DEFAULT',
    "backgroundColor" TEXT NOT NULL DEFAULT '#ffffff',
    "fontColor" TEXT NOT NULL DEFAULT '#000000',
    "buttonColor" TEXT NOT NULL DEFAULT '#000000',
    "buttonTextColor" TEXT NOT NULL DEFAULT '#ffffff',
    "discountBadgeColor" TEXT NOT NULL DEFAULT '#e53935',
    "discountTextColor" TEXT NOT NULL DEFAULT '#ffffff',
    "fontSize" INTEGER NOT NULL DEFAULT 14,
    "titleFontSize" INTEGER NOT NULL DEFAULT 18,
    "subtitleFontSize" INTEGER NOT NULL DEFAULT 14,
    "layoutType" TEXT NOT NULL DEFAULT 'LIST',
    "borderRadius" INTEGER NOT NULL DEFAULT 8,
    "borderStyle" TEXT NOT NULL DEFAULT 'SOLID',
    "borderWidth" INTEGER NOT NULL DEFAULT 1,
    "borderColor" TEXT NOT NULL DEFAULT '#e0e0e0',
    "padding" INTEGER NOT NULL DEFAULT 16,
    "marginTop" INTEGER NOT NULL DEFAULT 16,
    "marginBottom" INTEGER NOT NULL DEFAULT 16,
    "imageSize" TEXT NOT NULL DEFAULT 'MEDIUM',
    "discountLabelStyle" TEXT NOT NULL DEFAULT 'BADGE',
    "showCountdownTimer" BOOLEAN NOT NULL DEFAULT false,
    "customCss" TEXT NOT NULL DEFAULT '',
    "customJs" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "WidgetStyle_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_WidgetStyle" ("backgroundColor", "borderColor", "borderRadius", "borderStyle", "borderWidth", "bundleId", "buttonColor", "buttonTextColor", "createdAt", "discountBadgeColor", "discountLabelStyle", "discountTextColor", "fontColor", "fontSize", "id", "imageSize", "layoutType", "marginBottom", "marginTop", "padding", "showCountdownTimer", "subtitleFontSize", "template", "titleFontSize", "updatedAt") SELECT "backgroundColor", "borderColor", "borderRadius", "borderStyle", "borderWidth", "bundleId", "buttonColor", "buttonTextColor", "createdAt", "discountBadgeColor", "discountLabelStyle", "discountTextColor", "fontColor", "fontSize", "id", "imageSize", "layoutType", "marginBottom", "marginTop", "padding", "showCountdownTimer", "subtitleFontSize", "template", "titleFontSize", "updatedAt" FROM "WidgetStyle";
DROP TABLE "WidgetStyle";
ALTER TABLE "new_WidgetStyle" RENAME TO "WidgetStyle";
CREATE UNIQUE INDEX "WidgetStyle_bundleId_key" ON "WidgetStyle"("bundleId");
CREATE INDEX "WidgetStyle_bundleId_idx" ON "WidgetStyle"("bundleId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
