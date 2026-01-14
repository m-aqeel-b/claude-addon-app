-- CreateTable
CREATE TABLE "Bundle" (
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
    "shopifyDiscountId" TEXT
);

-- CreateTable
CREATE TABLE "BundleTargetedItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bundleId" TEXT NOT NULL,
    "shopifyResourceId" TEXT NOT NULL,
    "shopifyResourceType" TEXT NOT NULL,
    "title" TEXT,
    "imageUrl" TEXT,
    CONSTRAINT "BundleTargetedItem_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProductGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "bundleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ProductGroup_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProductGroupItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "productGroupId" TEXT NOT NULL,
    "shopifyResourceId" TEXT NOT NULL,
    "shopifyResourceType" TEXT NOT NULL,
    "title" TEXT,
    "imageUrl" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ProductGroupItem_productGroupId_fkey" FOREIGN KEY ("productGroupId") REFERENCES "ProductGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AddOnSet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "bundleId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "productTitle" TEXT,
    "productImageUrl" TEXT,
    "title" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "discountType" TEXT NOT NULL DEFAULT 'PERCENTAGE',
    "discountValue" DECIMAL,
    "discountLabel" TEXT,
    "customImageUrl" TEXT,
    "isDefaultSelected" BOOLEAN NOT NULL DEFAULT false,
    "subscriptionOnly" BOOLEAN NOT NULL DEFAULT false,
    "showQuantitySelector" BOOLEAN NOT NULL DEFAULT false,
    "maxQuantity" INTEGER NOT NULL DEFAULT 10,
    CONSTRAINT "AddOnSet_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AddOnSetVariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addOnSetId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "variantTitle" TEXT,
    "variantSku" TEXT,
    "variantPrice" DECIMAL,
    "position" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "AddOnSetVariant_addOnSetId_fkey" FOREIGN KEY ("addOnSetId") REFERENCES "AddOnSet" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WidgetStyle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "bundleId" TEXT NOT NULL,
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
    CONSTRAINT "WidgetStyle_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "shop" TEXT NOT NULL,
    "defaultSelectionMode" TEXT NOT NULL DEFAULT 'MULTIPLE',
    "defaultLayoutType" TEXT NOT NULL DEFAULT 'LIST',
    "defaultImageSize" TEXT NOT NULL DEFAULT 'MEDIUM',
    "defaultBackgroundColor" TEXT NOT NULL DEFAULT '#ffffff',
    "defaultFontColor" TEXT NOT NULL DEFAULT '#000000',
    "defaultButtonColor" TEXT NOT NULL DEFAULT '#000000',
    "defaultButtonTextColor" TEXT NOT NULL DEFAULT '#ffffff',
    "analyticsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" DATETIME
);

-- CreateIndex
CREATE INDEX "Bundle_shop_idx" ON "Bundle"("shop");

-- CreateIndex
CREATE INDEX "Bundle_shop_status_idx" ON "Bundle"("shop", "status");

-- CreateIndex
CREATE INDEX "Bundle_shop_status_startDate_endDate_idx" ON "Bundle"("shop", "status", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "BundleTargetedItem_bundleId_idx" ON "BundleTargetedItem"("bundleId");

-- CreateIndex
CREATE INDEX "BundleTargetedItem_shopifyResourceId_idx" ON "BundleTargetedItem"("shopifyResourceId");

-- CreateIndex
CREATE UNIQUE INDEX "BundleTargetedItem_bundleId_shopifyResourceId_key" ON "BundleTargetedItem"("bundleId", "shopifyResourceId");

-- CreateIndex
CREATE INDEX "ProductGroup_bundleId_idx" ON "ProductGroup"("bundleId");

-- CreateIndex
CREATE INDEX "ProductGroup_bundleId_position_idx" ON "ProductGroup"("bundleId", "position");

-- CreateIndex
CREATE INDEX "ProductGroupItem_productGroupId_idx" ON "ProductGroupItem"("productGroupId");

-- CreateIndex
CREATE INDEX "ProductGroupItem_productGroupId_position_idx" ON "ProductGroupItem"("productGroupId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ProductGroupItem_productGroupId_shopifyResourceId_key" ON "ProductGroupItem"("productGroupId", "shopifyResourceId");

-- CreateIndex
CREATE INDEX "AddOnSet_bundleId_idx" ON "AddOnSet"("bundleId");

-- CreateIndex
CREATE INDEX "AddOnSet_bundleId_position_idx" ON "AddOnSet"("bundleId", "position");

-- CreateIndex
CREATE INDEX "AddOnSet_shopifyProductId_idx" ON "AddOnSet"("shopifyProductId");

-- CreateIndex
CREATE INDEX "AddOnSetVariant_addOnSetId_idx" ON "AddOnSetVariant"("addOnSetId");

-- CreateIndex
CREATE INDEX "AddOnSetVariant_shopifyVariantId_idx" ON "AddOnSetVariant"("shopifyVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "AddOnSetVariant_addOnSetId_shopifyVariantId_key" ON "AddOnSetVariant"("addOnSetId", "shopifyVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "WidgetStyle_bundleId_key" ON "WidgetStyle"("bundleId");

-- CreateIndex
CREATE INDEX "WidgetStyle_bundleId_idx" ON "WidgetStyle"("bundleId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");

-- CreateIndex
CREATE INDEX "ShopSettings_shop_idx" ON "ShopSettings"("shop");
