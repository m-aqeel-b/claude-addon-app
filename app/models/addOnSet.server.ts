import type {
  AddOnSet,
  AddOnSetVariant,
  DiscountType,
  Prisma,
} from "@prisma/client";
import prisma from "~/db.server";

// ============================================================================
// TYPES
// ============================================================================

export type AddOnSetWithVariants = AddOnSet & {
  selectedVariants: AddOnSetVariant[];
};

export interface CreateAddOnSetInput {
  bundleId: string;
  shopifyProductId: string;
  productTitle?: string;
  productImageUrl?: string;
  title?: string;
  position?: number;
  discountType?: DiscountType;
  discountValue?: number;
  discountLabel?: string;
  customImageUrl?: string;
  isDefaultSelected?: boolean;
  subscriptionOnly?: boolean;
  showQuantitySelector?: boolean;
  maxQuantity?: number;
  selectedVariantIds?: string[];
}

export interface UpdateAddOnSetInput {
  shopifyProductId?: string;
  productTitle?: string;
  productImageUrl?: string;
  title?: string | null;
  position?: number;
  discountType?: DiscountType;
  discountValue?: number | null;
  discountLabel?: string | null;
  customImageUrl?: string | null;
  isDefaultSelected?: boolean;
  subscriptionOnly?: boolean;
  showQuantitySelector?: boolean;
  maxQuantity?: number;
}

export interface AddVariantInput {
  shopifyVariantId: string;
  variantTitle?: string;
  variantSku?: string;
  variantPrice?: number;
  position?: number;
}

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get all add-on sets for a bundle
 */
export async function getAddOnSets(
  bundleId: string
): Promise<AddOnSetWithVariants[]> {
  return prisma.addOnSet.findMany({
    where: { bundleId },
    include: {
      selectedVariants: {
        orderBy: { position: "asc" },
      },
    },
    orderBy: { position: "asc" },
  });
}

/**
 * Get a single add-on set by ID
 */
export async function getAddOnSet(
  id: string
): Promise<AddOnSetWithVariants | null> {
  return prisma.addOnSet.findUnique({
    where: { id },
    include: {
      selectedVariants: {
        orderBy: { position: "asc" },
      },
    },
  });
}

/**
 * Get the next position for a new add-on set in a bundle
 */
export async function getNextAddOnSetPosition(bundleId: string): Promise<number> {
  const maxPosition = await prisma.addOnSet.aggregate({
    where: { bundleId },
    _max: { position: true },
  });
  return (maxPosition._max.position ?? -1) + 1;
}

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Create a new add-on set
 */
export async function createAddOnSet(
  input: CreateAddOnSetInput
): Promise<AddOnSet> {
  const position = input.position ?? await getNextAddOnSetPosition(input.bundleId);

  // If FREE_GIFT, ensure isDefaultSelected is false
  const isDefaultSelected = input.discountType === "FREE_GIFT"
    ? false
    : (input.isDefaultSelected ?? false);

  return prisma.addOnSet.create({
    data: {
      bundleId: input.bundleId,
      shopifyProductId: input.shopifyProductId,
      productTitle: input.productTitle,
      productImageUrl: input.productImageUrl,
      title: input.title,
      position,
      discountType: input.discountType ?? "PERCENTAGE",
      discountValue: input.discountValue,
      discountLabel: input.discountLabel,
      customImageUrl: input.customImageUrl,
      isDefaultSelected,
      subscriptionOnly: input.subscriptionOnly ?? false,
      showQuantitySelector: input.showQuantitySelector ?? false,
      maxQuantity: input.maxQuantity ?? 10,
    },
  });
}

/**
 * Update an existing add-on set
 */
export async function updateAddOnSet(
  id: string,
  input: UpdateAddOnSetInput
): Promise<AddOnSet> {
  // If changing to FREE_GIFT, ensure isDefaultSelected is false
  let updateData: Prisma.AddOnSetUpdateInput = { ...input };

  if (input.discountType === "FREE_GIFT") {
    updateData.isDefaultSelected = false;
  }

  return prisma.addOnSet.update({
    where: { id },
    data: updateData,
  });
}

/**
 * Delete an add-on set
 */
export async function deleteAddOnSet(id: string): Promise<AddOnSet> {
  return prisma.addOnSet.delete({
    where: { id },
  });
}

/**
 * Reorder add-on sets within a bundle
 */
export async function reorderAddOnSets(
  bundleId: string,
  orderedIds: string[]
): Promise<void> {
  await prisma.$transaction(
    orderedIds.map((id, index) =>
      prisma.addOnSet.update({
        where: { id },
        data: { position: index },
      })
    )
  );
}

/**
 * Move an add-on set up in the order
 */
export async function moveAddOnSetUp(id: string): Promise<void> {
  const current = await prisma.addOnSet.findUnique({
    where: { id },
    select: { bundleId: true, position: true },
  });

  if (!current || current.position === 0) return;

  const above = await prisma.addOnSet.findFirst({
    where: {
      bundleId: current.bundleId,
      position: current.position - 1,
    },
  });

  if (above) {
    await prisma.$transaction([
      prisma.addOnSet.update({
        where: { id },
        data: { position: current.position - 1 },
      }),
      prisma.addOnSet.update({
        where: { id: above.id },
        data: { position: current.position },
      }),
    ]);
  }
}

/**
 * Move an add-on set down in the order
 */
export async function moveAddOnSetDown(id: string): Promise<void> {
  const current = await prisma.addOnSet.findUnique({
    where: { id },
    select: { bundleId: true, position: true },
  });

  if (!current) return;

  const below = await prisma.addOnSet.findFirst({
    where: {
      bundleId: current.bundleId,
      position: current.position + 1,
    },
  });

  if (below) {
    await prisma.$transaction([
      prisma.addOnSet.update({
        where: { id },
        data: { position: current.position + 1 },
      }),
      prisma.addOnSet.update({
        where: { id: below.id },
        data: { position: current.position },
      }),
    ]);
  }
}

// ============================================================================
// VARIANT MANAGEMENT
// ============================================================================

/**
 * Add a variant to an add-on set
 */
export async function addVariantToSet(
  addOnSetId: string,
  input: AddVariantInput
): Promise<AddOnSetVariant> {
  // Get next position
  const maxPosition = await prisma.addOnSetVariant.aggregate({
    where: { addOnSetId },
    _max: { position: true },
  });
  const position = input.position ?? (maxPosition._max.position ?? -1) + 1;

  return prisma.addOnSetVariant.create({
    data: {
      addOnSetId,
      shopifyVariantId: input.shopifyVariantId,
      variantTitle: input.variantTitle,
      variantSku: input.variantSku,
      variantPrice: input.variantPrice,
      position,
    },
  });
}

/**
 * Remove a variant from an add-on set
 */
export async function removeVariantFromSet(id: string): Promise<void> {
  await prisma.addOnSetVariant.delete({
    where: { id },
  });
}

/**
 * Set all variants for an add-on set (replaces existing)
 */
export async function setVariantsForSet(
  addOnSetId: string,
  variants: AddVariantInput[]
): Promise<void> {
  await prisma.$transaction([
    // Remove all existing variants
    prisma.addOnSetVariant.deleteMany({
      where: { addOnSetId },
    }),
    // Add new variants
    ...variants.map((variant, index) =>
      prisma.addOnSetVariant.create({
        data: {
          addOnSetId,
          shopifyVariantId: variant.shopifyVariantId,
          variantTitle: variant.variantTitle,
          variantSku: variant.variantSku,
          variantPrice: variant.variantPrice,
          position: variant.position ?? index,
        },
      })
    ),
  ]);
}

/**
 * Update cached variant data (called from webhook)
 */
export async function updateVariantCache(
  shopifyVariantId: string,
  data: {
    variantTitle?: string;
    variantSku?: string;
    variantPrice?: number;
  }
): Promise<void> {
  await prisma.addOnSetVariant.updateMany({
    where: { shopifyVariantId },
    data,
  });
}
