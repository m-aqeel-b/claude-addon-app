import type {
  Bundle,
  BundleStatus,
  SelectionMode,
  TargetingType,
  DiscountCombination,
  AddOnSet,
  WidgetStyle,
  BundleTargetedItem,
  ProductGroup,
  ProductGroupItem,
  Prisma,
} from "@prisma/client";
import prisma from "~/db.server";

// ============================================================================
// TYPES
// ============================================================================

export type ProductGroupWithItems = ProductGroup & {
  items: ProductGroupItem[];
};

export type BundleWithRelations = Bundle & {
  addOnSets: AddOnSet[];
  widgetStyle: WidgetStyle | null;
  targetedItems?: BundleTargetedItem[];
  productGroups?: ProductGroupWithItems[];
  _count?: {
    addOnSets: number;
    targetedItems: number;
    productGroups: number;
  };
};

export interface CreateBundleInput {
  shop: string;
  title: string;
  subtitle?: string;
  status?: BundleStatus;
  startDate?: Date;
  endDate?: Date;
  selectionMode?: SelectionMode;
  targetingType?: TargetingType;
  combineWithProductDiscounts?: DiscountCombination;
  combineWithOrderDiscounts?: DiscountCombination;
  combineWithShippingDiscounts?: DiscountCombination;
  deleteAddOnsWithMain?: boolean;
}

export interface UpdateBundleInput {
  title?: string;
  subtitle?: string | null;
  status?: BundleStatus;
  startDate?: Date | null;
  endDate?: Date | null;
  selectionMode?: SelectionMode;
  targetingType?: TargetingType;
  combineWithProductDiscounts?: DiscountCombination;
  combineWithOrderDiscounts?: DiscountCombination;
  combineWithShippingDiscounts?: DiscountCombination;
  shopifyDiscountId?: string | null;
  deleteAddOnsWithMain?: boolean;
}

export interface BundleListFilters {
  status?: BundleStatus;
  search?: string;
}

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get all bundles for a shop with optional filtering
 */
export async function getBundles(
  shop: string,
  filters?: BundleListFilters
): Promise<BundleWithRelations[]> {
  const where: Prisma.BundleWhereInput = {
    shop,
  };

  if (filters?.status) {
    where.status = filters.status;
  }

  if (filters?.search) {
    where.OR = [
      { title: { contains: filters.search } },
      { subtitle: { contains: filters.search } },
    ];
  }

  return prisma.bundle.findMany({
    where,
    include: {
      addOnSets: {
        orderBy: { position: "asc" },
      },
      widgetStyle: true,
      _count: {
        select: {
          addOnSets: true,
          targetedItems: true,
          productGroups: true,
        },
      },
    },
    orderBy: { updatedAt: "desc" },
  });
}

/**
 * Get a single bundle by ID with all relations
 */
export async function getBundle(
  id: string,
  shop: string
): Promise<BundleWithRelations | null> {
  return prisma.bundle.findFirst({
    where: { id, shop },
    include: {
      addOnSets: {
        include: {
          selectedVariants: {
            orderBy: { position: "asc" },
          },
        },
        orderBy: { position: "asc" },
      },
      targetedItems: true,
      productGroups: {
        include: {
          items: {
            orderBy: { position: "asc" },
          },
        },
        orderBy: { position: "asc" },
      },
      widgetStyle: true,
    },
  });
}

/**
 * Check if a bundle with the given title already exists for the shop
 */
export async function bundleTitleExists(
  shop: string,
  title: string,
  excludeId?: string
): Promise<boolean> {
  const count = await prisma.bundle.count({
    where: {
      shop,
      title,
      id: excludeId ? { not: excludeId } : undefined,
    },
  });
  return count > 0;
}

/**
 * Get active bundles for a specific product
 * Used by the widget to determine which bundle to display
 */
export async function getActiveBundleForProduct(
  shop: string,
  productId: string
): Promise<BundleWithRelations | null> {
  const now = new Date();

  // First, check for bundles targeting ALL_PRODUCTS
  const allProductsBundle = await prisma.bundle.findFirst({
    where: {
      shop,
      status: "ACTIVE",
      targetingType: "ALL_PRODUCTS",
      OR: [
        { startDate: null },
        { startDate: { lte: now } },
      ],
      AND: [
        {
          OR: [
            { endDate: null },
            { endDate: { gte: now } },
          ],
        },
      ],
    },
    include: {
      addOnSets: {
        include: {
          selectedVariants: {
            orderBy: { position: "asc" },
          },
        },
        orderBy: { position: "asc" },
      },
      widgetStyle: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  if (allProductsBundle) {
    return allProductsBundle;
  }

  // Check for bundles targeting this specific product
  const specificProductBundle = await prisma.bundle.findFirst({
    where: {
      shop,
      status: "ACTIVE",
      targetingType: "SPECIFIC_PRODUCTS",
      targetedItems: {
        some: {
          shopifyResourceId: productId,
        },
      },
      OR: [
        { startDate: null },
        { startDate: { lte: now } },
      ],
      AND: [
        {
          OR: [
            { endDate: null },
            { endDate: { gte: now } },
          ],
        },
      ],
    },
    include: {
      addOnSets: {
        include: {
          selectedVariants: {
            orderBy: { position: "asc" },
          },
        },
        orderBy: { position: "asc" },
      },
      widgetStyle: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  if (specificProductBundle) {
    return specificProductBundle;
  }

  // Check for product groups containing this product
  const productGroupBundle = await prisma.bundle.findFirst({
    where: {
      shop,
      status: "ACTIVE",
      targetingType: "PRODUCT_GROUPS",
      productGroups: {
        some: {
          items: {
            some: {
              shopifyResourceId: productId,
            },
          },
        },
      },
      OR: [
        { startDate: null },
        { startDate: { lte: now } },
      ],
      AND: [
        {
          OR: [
            { endDate: null },
            { endDate: { gte: now } },
          ],
        },
      ],
    },
    include: {
      addOnSets: {
        include: {
          selectedVariants: {
            orderBy: { position: "asc" },
          },
        },
        orderBy: { position: "asc" },
      },
      productGroups: {
        include: {
          items: {
            orderBy: { position: "asc" },
          },
        },
        orderBy: { position: "asc" },
      },
      widgetStyle: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  return productGroupBundle;
}

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Create a new bundle
 */
export async function createBundle(
  input: CreateBundleInput
): Promise<Bundle> {
  return prisma.bundle.create({
    data: {
      shop: input.shop,
      title: input.title,
      subtitle: input.subtitle,
      status: input.status ?? "DRAFT",
      startDate: input.startDate,
      endDate: input.endDate,
      selectionMode: input.selectionMode ?? "MULTIPLE",
      targetingType: input.targetingType ?? "ALL_PRODUCTS",
      combineWithProductDiscounts: input.combineWithProductDiscounts ?? "COMBINE",
      combineWithOrderDiscounts: input.combineWithOrderDiscounts ?? "COMBINE",
      combineWithShippingDiscounts: input.combineWithShippingDiscounts ?? "COMBINE",
      deleteAddOnsWithMain: input.deleteAddOnsWithMain ?? false,
      // Create default widget style
      widgetStyle: {
        create: {},
      },
    },
  });
}

/**
 * Update an existing bundle
 */
export async function updateBundle(
  id: string,
  shop: string,
  input: UpdateBundleInput
): Promise<Bundle> {
  return prisma.bundle.update({
    where: { id },
    data: {
      ...input,
      updatedAt: new Date(),
    },
  });
}

/**
 * Delete a bundle and all related data (cascades automatically)
 */
export async function deleteBundle(
  id: string,
  shop: string
): Promise<Bundle> {
  // Verify the bundle belongs to the shop before deleting
  const bundle = await prisma.bundle.findFirst({
    where: { id, shop },
  });

  if (!bundle) {
    throw new Error("Bundle not found");
  }

  return prisma.bundle.delete({
    where: { id },
  });
}

/**
 * Duplicate a bundle with all its settings
 */
export async function duplicateBundle(
  id: string,
  shop: string
): Promise<Bundle> {
  const original = await getBundle(id, shop);

  if (!original) {
    throw new Error("Bundle not found");
  }

  // Create new bundle with copied data
  const newBundle = await prisma.bundle.create({
    data: {
      shop: original.shop,
      title: `${original.title} (Copy)`,
      subtitle: original.subtitle,
      status: "DRAFT", // Always start as draft
      startDate: original.startDate,
      endDate: original.endDate,
      selectionMode: original.selectionMode,
      targetingType: original.targetingType,
      combineWithProductDiscounts: original.combineWithProductDiscounts,
      combineWithOrderDiscounts: original.combineWithOrderDiscounts,
      combineWithShippingDiscounts: original.combineWithShippingDiscounts,
      // Copy widget style
      widgetStyle: original.widgetStyle
        ? {
            create: {
              backgroundColor: original.widgetStyle.backgroundColor,
              fontColor: original.widgetStyle.fontColor,
              buttonColor: original.widgetStyle.buttonColor,
              buttonTextColor: original.widgetStyle.buttonTextColor,
              discountBadgeColor: original.widgetStyle.discountBadgeColor,
              discountTextColor: original.widgetStyle.discountTextColor,
              fontSize: original.widgetStyle.fontSize,
              titleFontSize: original.widgetStyle.titleFontSize,
              subtitleFontSize: original.widgetStyle.subtitleFontSize,
              layoutType: original.widgetStyle.layoutType,
              borderRadius: original.widgetStyle.borderRadius,
              borderStyle: original.widgetStyle.borderStyle,
              borderWidth: original.widgetStyle.borderWidth,
              borderColor: original.widgetStyle.borderColor,
              padding: original.widgetStyle.padding,
              marginTop: original.widgetStyle.marginTop,
              marginBottom: original.widgetStyle.marginBottom,
              imageSize: original.widgetStyle.imageSize,
              discountLabelStyle: original.widgetStyle.discountLabelStyle,
            },
          }
        : { create: {} },
      // Copy add-on sets
      addOnSets: {
        create: original.addOnSets.map((set) => ({
          shopifyProductId: set.shopifyProductId,
          productTitle: set.productTitle,
          productImageUrl: set.productImageUrl,
          title: set.title,
          position: set.position,
          discountType: set.discountType,
          discountValue: set.discountValue,
          discountLabel: set.discountLabel,
          customImageUrl: set.customImageUrl,
          isDefaultSelected: set.isDefaultSelected,
          subscriptionOnly: set.subscriptionOnly,
          showQuantitySelector: set.showQuantitySelector,
          maxQuantity: set.maxQuantity,
        })),
      },
    },
  });

  return newBundle;
}

// ============================================================================
// STATISTICS
// ============================================================================

/**
 * Get bundle statistics for a shop
 */
export async function getBundleStats(shop: string) {
  const [total, active, draft, archived] = await Promise.all([
    prisma.bundle.count({ where: { shop } }),
    prisma.bundle.count({ where: { shop, status: "ACTIVE" } }),
    prisma.bundle.count({ where: { shop, status: "DRAFT" } }),
    prisma.bundle.count({ where: { shop, status: "ARCHIVED" } }),
  ]);

  return { total, active, draft, archived };
}
