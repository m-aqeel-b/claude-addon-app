/**
 * Targeting Model - Manages bundle targeted items and product groups
 */

import type {
  BundleTargetedItem,
  ProductGroup,
  ProductGroupItem,
} from "@prisma/client";
import prisma from "~/db.server";

// ============================================================================
// TYPES
// ============================================================================

export type ProductGroupWithItems = ProductGroup & {
  items: ProductGroupItem[];
};

export interface CreateTargetedItemInput {
  bundleId: string;
  shopifyResourceId: string;
  shopifyResourceType: "Product" | "Collection";
  title?: string;
  imageUrl?: string;
}

export interface CreateProductGroupInput {
  bundleId: string;
  title: string;
  position?: number;
}

export interface UpdateProductGroupInput {
  title?: string;
  position?: number;
}

export interface CreateProductGroupItemInput {
  productGroupId: string;
  shopifyResourceId: string;
  shopifyResourceType: "Product" | "Collection";
  title?: string;
  imageUrl?: string;
  position?: number;
}

// ============================================================================
// TARGETED ITEMS (SPECIFIC_PRODUCTS targeting type)
// ============================================================================

/**
 * Get all targeted items for a bundle
 */
export async function getTargetedItems(bundleId: string): Promise<BundleTargetedItem[]> {
  return prisma.bundleTargetedItem.findMany({
    where: { bundleId },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Add a targeted item to a bundle
 */
export async function addTargetedItem(
  input: CreateTargetedItemInput
): Promise<BundleTargetedItem> {
  return prisma.bundleTargetedItem.create({
    data: {
      bundleId: input.bundleId,
      shopifyResourceId: input.shopifyResourceId,
      shopifyResourceType: input.shopifyResourceType,
      title: input.title,
      imageUrl: input.imageUrl,
    },
  });
}

/**
 * Add multiple targeted items to a bundle
 */
export async function addTargetedItems(
  bundleId: string,
  items: Array<Omit<CreateTargetedItemInput, "bundleId">>
): Promise<number> {
  // Filter out items that already exist
  const existingItems = await prisma.bundleTargetedItem.findMany({
    where: { bundleId },
    select: { shopifyResourceId: true },
  });
  const existingIds = new Set(existingItems.map((i) => i.shopifyResourceId));
  const newItems = items.filter((item) => !existingIds.has(item.shopifyResourceId));

  if (newItems.length === 0) {
    return 0;
  }

  const result = await prisma.bundleTargetedItem.createMany({
    data: newItems.map((item) => ({
      bundleId,
      shopifyResourceId: item.shopifyResourceId,
      shopifyResourceType: item.shopifyResourceType,
      title: item.title,
      imageUrl: item.imageUrl,
    })),
  });
  return result.count;
}

/**
 * Remove a targeted item from a bundle
 */
export async function removeTargetedItem(itemId: string): Promise<BundleTargetedItem> {
  return prisma.bundleTargetedItem.delete({
    where: { id: itemId },
  });
}

/**
 * Remove all targeted items from a bundle
 */
export async function clearTargetedItems(bundleId: string): Promise<number> {
  const result = await prisma.bundleTargetedItem.deleteMany({
    where: { bundleId },
  });
  return result.count;
}

// ============================================================================
// PRODUCT GROUPS (PRODUCT_GROUPS targeting type)
// ============================================================================

/**
 * Get all product groups for a bundle with their items
 */
export async function getProductGroups(bundleId: string): Promise<ProductGroupWithItems[]> {
  return prisma.productGroup.findMany({
    where: { bundleId },
    include: {
      items: {
        orderBy: { position: "asc" },
      },
    },
    orderBy: { position: "asc" },
  });
}

/**
 * Get a single product group with its items
 */
export async function getProductGroup(groupId: string): Promise<ProductGroupWithItems | null> {
  return prisma.productGroup.findUnique({
    where: { id: groupId },
    include: {
      items: {
        orderBy: { position: "asc" },
      },
    },
  });
}

/**
 * Create a new product group
 */
export async function createProductGroup(
  input: CreateProductGroupInput
): Promise<ProductGroup> {
  // Get the next position if not specified
  let position = input.position;
  if (position === undefined) {
    const maxPosition = await prisma.productGroup.aggregate({
      where: { bundleId: input.bundleId },
      _max: { position: true },
    });
    position = (maxPosition._max.position ?? -1) + 1;
  }

  return prisma.productGroup.create({
    data: {
      bundleId: input.bundleId,
      title: input.title,
      position,
    },
  });
}

/**
 * Update a product group
 */
export async function updateProductGroup(
  groupId: string,
  input: UpdateProductGroupInput
): Promise<ProductGroup> {
  return prisma.productGroup.update({
    where: { id: groupId },
    data: input,
  });
}

/**
 * Delete a product group and all its items
 */
export async function deleteProductGroup(groupId: string): Promise<ProductGroup> {
  return prisma.productGroup.delete({
    where: { id: groupId },
  });
}

/**
 * Clear all product groups from a bundle
 */
export async function clearProductGroups(bundleId: string): Promise<number> {
  const result = await prisma.productGroup.deleteMany({
    where: { bundleId },
  });
  return result.count;
}

/**
 * Reorder product groups
 */
export async function reorderProductGroups(
  bundleId: string,
  groupIds: string[]
): Promise<void> {
  await prisma.$transaction(
    groupIds.map((id, index) =>
      prisma.productGroup.update({
        where: { id },
        data: { position: index },
      })
    )
  );
}

// ============================================================================
// PRODUCT GROUP ITEMS
// ============================================================================

/**
 * Add an item to a product group
 */
export async function addProductGroupItem(
  input: CreateProductGroupItemInput
): Promise<ProductGroupItem> {
  // Get the next position if not specified
  let position = input.position;
  if (position === undefined) {
    const maxPosition = await prisma.productGroupItem.aggregate({
      where: { productGroupId: input.productGroupId },
      _max: { position: true },
    });
    position = (maxPosition._max.position ?? -1) + 1;
  }

  return prisma.productGroupItem.create({
    data: {
      productGroupId: input.productGroupId,
      shopifyResourceId: input.shopifyResourceId,
      shopifyResourceType: input.shopifyResourceType,
      title: input.title,
      imageUrl: input.imageUrl,
      position,
    },
  });
}

/**
 * Add multiple items to a product group
 */
export async function addProductGroupItems(
  productGroupId: string,
  items: Array<Omit<CreateProductGroupItemInput, "productGroupId">>
): Promise<number> {
  // Get the starting position
  const maxPosition = await prisma.productGroupItem.aggregate({
    where: { productGroupId },
    _max: { position: true },
  });
  let nextPosition = (maxPosition._max.position ?? -1) + 1;

  // Filter out items that already exist
  const existingItems = await prisma.productGroupItem.findMany({
    where: { productGroupId },
    select: { shopifyResourceId: true },
  });
  const existingIds = new Set(existingItems.map((i) => i.shopifyResourceId));
  const newItems = items.filter((item) => !existingIds.has(item.shopifyResourceId));

  if (newItems.length === 0) {
    return 0;
  }

  const result = await prisma.productGroupItem.createMany({
    data: newItems.map((item) => ({
      productGroupId,
      shopifyResourceId: item.shopifyResourceId,
      shopifyResourceType: item.shopifyResourceType,
      title: item.title,
      imageUrl: item.imageUrl,
      position: nextPosition++,
    })),
  });
  return result.count;
}

/**
 * Remove an item from a product group
 */
export async function removeProductGroupItem(itemId: string): Promise<ProductGroupItem> {
  return prisma.productGroupItem.delete({
    where: { id: itemId },
  });
}

/**
 * Clear all items from a product group
 */
export async function clearProductGroupItems(productGroupId: string): Promise<number> {
  const result = await prisma.productGroupItem.deleteMany({
    where: { productGroupId },
  });
  return result.count;
}

/**
 * Reorder items within a product group
 */
export async function reorderProductGroupItems(
  productGroupId: string,
  itemIds: string[]
): Promise<void> {
  await prisma.$transaction(
    itemIds.map((id, index) =>
      prisma.productGroupItem.update({
        where: { id },
        data: { position: index },
      })
    )
  );
}
