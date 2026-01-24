-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Bundle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "startDate" DATETIME,
    "endDate" DATETIME,
    "selectionMode" TEXT NOT NULL DEFAULT 'MULTIPLE',
    "targetingType" TEXT NOT NULL DEFAULT 'ALL_PRODUCTS',
    "combineWithProductDiscounts" TEXT NOT NULL DEFAULT 'COMBINE',
    "combineWithOrderDiscounts" TEXT NOT NULL DEFAULT 'COMBINE',
    "combineWithShippingDiscounts" TEXT NOT NULL DEFAULT 'COMBINE',
    "deleteAddOnsWithMain" BOOLEAN NOT NULL DEFAULT false,
    "shopifyDiscountId" TEXT
);
INSERT INTO "new_Bundle" ("combineWithOrderDiscounts", "combineWithProductDiscounts", "combineWithShippingDiscounts", "createdAt", "endDate", "id", "selectionMode", "shop", "shopifyDiscountId", "startDate", "status", "subtitle", "targetingType", "title", "updatedAt") SELECT "combineWithOrderDiscounts", "combineWithProductDiscounts", "combineWithShippingDiscounts", "createdAt", "endDate", "id", "selectionMode", "shop", "shopifyDiscountId", "startDate", "status", "subtitle", "targetingType", "title", "updatedAt" FROM "Bundle";
DROP TABLE "Bundle";
ALTER TABLE "new_Bundle" RENAME TO "Bundle";
CREATE INDEX "Bundle_shop_idx" ON "Bundle"("shop");
CREATE INDEX "Bundle_shop_status_idx" ON "Bundle"("shop", "status");
CREATE INDEX "Bundle_shop_status_startDate_endDate_idx" ON "Bundle"("shop", "status", "startDate", "endDate");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
