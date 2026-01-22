/**
 * Metafield Sync Service
 * Syncs bundle configuration to Shopify metafields for use by:
 * - Discount Function (reads config to apply discounts)
 * - Theme App Extension (reads config to display widget)
 */

// Admin API client type - matches Shopify's admin graphql client
interface AdminGraphQLClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<{
    json: () => Promise<{ data?: unknown; errors?: Array<{ message: string }> }>;
  }>;
}
import type { BundleWithRelations } from "../models/bundle.server";
import { getAddOnSets } from "../models/addOnSet.server";
import { getWidgetStyle } from "../models/widgetStyle.server";

// Metafield namespace for the app (defined in shopify.app.toml)
// Note: Use "addon-bundle" not "$app:addon-bundle" - the $app prefix is automatic
const METAFIELD_NAMESPACE = "addon-bundle";

// Types for metafield configuration
interface AddOnConfig {
  addOnId: string;
  productTitle: string;
  imageUrl: string | null;
  title: string | null;
  targetVariantIds: string[];
  discountType: string;
  discountValue: number | null;
  discountLabel: string | null;
  isDefaultSelected: boolean;
  subscriptionOnly: boolean;
  showQuantitySelector: boolean;
  maxQuantity: number;
  message: string;
}

interface DiscountFunctionConfig {
  bundleId: string;
  addOns: AddOnConfig[];
  selectionStrategy: "FIRST" | "ALL";
}

interface WidgetConfig {
  bundleId: string;
  title: string;
  subtitle: string | null;
  selectionMode: string;
  targetingType: string;
  startDate: string | null;
  endDate: string | null;
  deleteAddonsOnMainDelete: boolean; // Cart Transform: remove addons when main product deleted
  addOns: Array<{
    addOnId: string;
    shopifyProductId: string;
    productHandle: string | null; // Product handle for fetching market-specific prices
    productTitle: string | null;
    imageUrl: string | null;
    title: string | null;
    discountType: string;
    discountValue: number | null;
    discountLabel: string | null;
    isDefaultSelected: boolean;
    subscriptionOnly: boolean;
    showQuantitySelector: boolean;
    maxQuantity: number;
    selectedVariants: Array<{
      shopifyVariantId: string;
      variantTitle: string | null;
      variantPrice: number | null;
    }>;
  }>;
  style: Record<string, string | number | boolean>;
  productGroups?: Array<{
    title: string;
    addOns: string[]; // Add-on IDs
  }>;
}

/**
 * Build discount function configuration from bundle data
 */
export function buildDiscountConfig(
  bundle: BundleWithRelations,
  addOnSets: Awaited<ReturnType<typeof getAddOnSets>>
): DiscountFunctionConfig {
  const addOns: AddOnConfig[] = addOnSets.map((addOn) => ({
    addOnId: addOn.id,
    productTitle: addOn.productTitle || "",
    imageUrl: addOn.productImageUrl || addOn.customImageUrl,
    title: addOn.title,
    targetVariantIds: addOn.selectedVariants.map((v) => v.shopifyVariantId),
    discountType: addOn.discountType,
    discountValue: addOn.discountValue ? Number(addOn.discountValue) : null,
    discountLabel: addOn.discountLabel,
    isDefaultSelected: addOn.isDefaultSelected,
    subscriptionOnly: addOn.subscriptionOnly,
    showQuantitySelector: addOn.showQuantitySelector,
    maxQuantity: addOn.maxQuantity,
    message: addOn.discountLabel || getDefaultMessage(addOn.discountType, addOn.discountValue),
  }));

  return {
    bundleId: bundle.id,
    addOns,
    selectionStrategy: bundle.selectionMode === "SINGLE" ? "FIRST" : "ALL",
  };
}

/**
 * Build widget configuration from bundle data
 * @param productHandles - Map of Shopify Product GID to product handle
 */
export function buildWidgetConfig(
  bundle: BundleWithRelations,
  addOnSets: Awaited<ReturnType<typeof getAddOnSets>>,
  widgetStyle: Awaited<ReturnType<typeof getWidgetStyle>>,
  productHandles: Map<string, string> = new Map()
): WidgetConfig {
  // Type assertion for properties that may not be in Prisma client yet
  const bundleExt = bundle as Record<string, unknown>;

  return {
    bundleId: bundle.id,
    title: bundle.title,
    subtitle: bundle.subtitle,
    selectionMode: bundle.selectionMode,
    targetingType: bundle.targetingType,
    startDate: bundle.startDate ? bundle.startDate.toISOString() : null,
    endDate: bundle.endDate ? bundle.endDate.toISOString() : null,
    // Cart Transform: controls whether addons are removed when main product is deleted
    deleteAddonsOnMainDelete: Boolean(bundleExt.deleteAddOnsWithMain) || false,
    addOns: addOnSets.map((addOn) => ({
      addOnId: addOn.id,
      shopifyProductId: addOn.shopifyProductId,
      productHandle: productHandles.get(addOn.shopifyProductId) || null,
      productTitle: addOn.productTitle,
      imageUrl: addOn.productImageUrl || addOn.customImageUrl,
      title: addOn.title,
      discountType: addOn.discountType,
      discountValue: addOn.discountValue ? Number(addOn.discountValue) : null,
      discountLabel: addOn.discountLabel,
      isDefaultSelected: addOn.isDefaultSelected,
      subscriptionOnly: addOn.subscriptionOnly,
      showQuantitySelector: addOn.showQuantitySelector,
      maxQuantity: addOn.maxQuantity,
      selectedVariants: addOn.selectedVariants.map((v) => ({
        shopifyVariantId: v.shopifyVariantId,
        variantTitle: v.variantTitle,
        variantPrice: v.variantPrice ? Number(v.variantPrice) : null,
      })),
    })),
    style: widgetStyle
      ? {
          backgroundColor: widgetStyle.backgroundColor,
          fontColor: widgetStyle.fontColor,
          buttonColor: widgetStyle.buttonColor,
          buttonTextColor: widgetStyle.buttonTextColor,
          discountBadgeColor: widgetStyle.discountBadgeColor,
          discountTextColor: widgetStyle.discountTextColor,
          fontSize: widgetStyle.fontSize,
          titleFontSize: widgetStyle.titleFontSize,
          subtitleFontSize: widgetStyle.subtitleFontSize,
          layoutType: widgetStyle.layoutType,
          borderRadius: widgetStyle.borderRadius,
          borderStyle: widgetStyle.borderStyle,
          borderWidth: widgetStyle.borderWidth,
          borderColor: widgetStyle.borderColor,
          padding: widgetStyle.padding,
          marginTop: widgetStyle.marginTop,
          marginBottom: widgetStyle.marginBottom,
          imageSize: widgetStyle.imageSize,
          discountLabelStyle: widgetStyle.discountLabelStyle,
          // Type assertions needed until Prisma client is regenerated
          showCountdownTimer: Boolean((widgetStyle as Record<string, unknown>).showCountdownTimer) || false,
          customCss: String((widgetStyle as Record<string, unknown>).customCss || ""),
          customJs: String((widgetStyle as Record<string, unknown>).customJs || ""),
        }
      : {},
  };
}

/**
 * Get default discount message
 */
function getDefaultMessage(discountType: string, value: unknown): string {
  const numValue = value ? Number(value) : 0;
  switch (discountType) {
    case "PERCENTAGE":
      return `${numValue}% off`;
    case "FIXED_AMOUNT":
      return `$${numValue} off`;
    case "FIXED_PRICE":
      return `Special price`;
    case "FREE_GIFT":
      return "Free!";
    default:
      return "";
  }
}

/**
 * Fetch product handles from Shopify for a list of product GIDs
 * Returns a Map of product GID -> handle
 */
export async function fetchProductHandles(
  admin: AdminGraphQLClient,
  productIds: string[]
): Promise<Map<string, string>> {
  const handles = new Map<string, string>();

  if (productIds.length === 0) {
    return handles;
  }

  // Process in chunks of 50 (GraphQL nodes query limit)
  const chunks = chunkArray(productIds, 50);

  for (const chunk of chunks) {
    try {
      const response = await admin.graphql(
        `#graphql
        query GetProductHandles($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              handle
            }
          }
        }`,
        {
          variables: { ids: chunk },
        }
      );

      const result = await response.json();
      const nodes = (result.data as { nodes?: Array<{ id: string; handle: string }> })?.nodes || [];

      for (const node of nodes) {
        if (node?.id && node?.handle) {
          handles.set(node.id, node.handle);
        }
      }
    } catch (error) {
      console.error("[Metafield Sync] Error fetching product handles:", error);
    }
  }

  console.log("[Metafield Sync] Fetched handles for", handles.size, "products");
  return handles;
}

/**
 * Sync bundle configuration to product metafields for widget display
 * Called when bundle targeting includes specific products
 */
export async function syncProductMetafields(
  admin: AdminGraphQLClient,
  productIds: string[],
  widgetConfig: WidgetConfig
): Promise<void> {
  if (productIds.length === 0) {
    console.log("[Metafield Sync] No product IDs to sync");
    return;
  }

  const configJson = JSON.stringify(widgetConfig);
  console.log("[Metafield Sync] Syncing to", productIds.length, "products");

  // Build metafield input for each product
  const metafields = productIds.map((productId) => ({
    ownerId: productId,
    namespace: METAFIELD_NAMESPACE,
    key: "config",
    value: configJson,
    type: "json",
  }));

  // Use metafieldsSet mutation (can handle up to 25 at a time)
  const chunks = chunkArray(metafields, 25);

  for (const chunk of chunks) {
    try {
      const response = await admin.graphql(
        `#graphql
        mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields {
              id
              namespace
              key
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: { metafields: chunk },
        }
      );

      const result = await response.json();

      if (result.errors) {
        console.error("[Metafield Sync] GraphQL errors:", result.errors);
      }

      const data = result.data as { metafieldsSet?: { metafields?: Array<{ id: string }>; userErrors?: Array<{ field: string; message: string }> } };
      if (data?.metafieldsSet?.userErrors?.length) {
        console.error("[Metafield Sync] User errors:", data.metafieldsSet.userErrors);
      } else {
        console.log("[Metafield Sync] Successfully synced", data?.metafieldsSet?.metafields?.length, "product metafields");
      }
    } catch (error) {
      console.error("[Metafield Sync] Error syncing product metafields:", error);
    }
  }
}

/**
 * Sync bundle configuration to shop metafields for global bundles (ALL_PRODUCTS)
 */
export async function syncShopMetafields(
  admin: AdminGraphQLClient,
  shopGid: string,
  widgetConfig: WidgetConfig
): Promise<void> {
  console.log("[Metafield Sync] Syncing shop metafield for shop:", shopGid);
  console.log("[Metafield Sync] Widget config:", JSON.stringify(widgetConfig, null, 2));

  try {
    const response = await admin.graphql(
      `#graphql
      mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            namespace
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          metafields: [
            {
              ownerId: shopGid,
              namespace: METAFIELD_NAMESPACE,
              key: "global_config",
              value: JSON.stringify(widgetConfig),
              type: "json",
            },
          ],
        },
      }
    );

    const result = await response.json();

    if (result.errors) {
      console.error("[Metafield Sync] GraphQL errors:", result.errors);
      return;
    }

    const data = result.data as { metafieldsSet?: { metafields?: Array<{ id: string; namespace: string; key: string }>; userErrors?: Array<{ field: string; message: string }> } };
    if (data?.metafieldsSet?.userErrors?.length) {
      console.error("[Metafield Sync] User errors:", data.metafieldsSet.userErrors);
    } else {
      console.log("[Metafield Sync] Successfully synced shop metafield:", data?.metafieldsSet?.metafields);
    }
  } catch (error) {
    console.error("[Metafield Sync] Error syncing shop metafield:", error);
  }
}

/**
 * Clear metafields when bundle is deleted or deactivated
 */
export async function clearProductMetafields(
  admin: AdminGraphQLClient,
  productIds: string[]
): Promise<void> {
  if (productIds.length === 0) return;

  console.log("[Metafield Sync] Clearing metafields for", productIds.length, "products");

  // Delete metafields using ownerId + namespace + key (not by id)
  // MetafieldIdentifierInput requires ownerId, namespace, key - NOT id
  const metafieldsToDelete = productIds.map((productId) => ({
    ownerId: productId,
    namespace: METAFIELD_NAMESPACE,
    key: "config",
  }));

  // Process in chunks of 25 (API limit)
  const chunks = chunkArray(metafieldsToDelete, 25);

  for (const chunk of chunks) {
    try {
      const response = await admin.graphql(
        `#graphql
        mutation MetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) {
            deletedMetafields {
              ownerId
              namespace
              key
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            metafields: chunk,
          },
        }
      );

      const result = await response.json();
      const data = result.data as {
        metafieldsDelete?: {
          deletedMetafields?: Array<{ ownerId: string; namespace: string; key: string }>;
          userErrors?: Array<{ field: string; message: string }>;
        };
      };

      if (data?.metafieldsDelete?.userErrors?.length) {
        console.error("[Metafield Sync] User errors:", data.metafieldsDelete.userErrors);
      } else {
        console.log("[Metafield Sync] Cleared", data?.metafieldsDelete?.deletedMetafields?.length || 0, "product metafields");
      }
    } catch (error) {
      console.error("[Metafield Sync] Error clearing product metafields:", error);
    }
  }
}

/**
 * Clear global shop metafield
 * Uses direct deletion by ownerId + namespace + key (more reliable than ID-based)
 */
export async function clearShopMetafield(
  admin: AdminGraphQLClient,
  shopGid: string
): Promise<{ success: boolean; error?: string }> {
  console.log("[clearShopMetafield] Starting - shopGid:", shopGid);

  // Try multiple namespace variations
  const namespacesToTry = [
    METAFIELD_NAMESPACE,           // "addon-bundle"
    `$app:${METAFIELD_NAMESPACE}`, // "$app:addon-bundle"
  ];

  const keysToTry = ["global_config", "config"];

  let deletedCount = 0;
  let lastError: string | undefined;

  // First, list ALL metafields on the shop to see what's actually there
  try {
    const listResponse = await admin.graphql(
      `#graphql
      query ListAllShopMetafields {
        shop {
          metafields(first: 100) {
            nodes {
              id
              namespace
              key
            }
          }
        }
      }`
    );
    const listResult = await listResponse.json();
    const allMetafields = (listResult.data as { shop?: { metafields?: { nodes?: Array<{ id: string; namespace: string; key: string }> } } })?.shop?.metafields?.nodes || [];
    console.log("[clearShopMetafield] All shop metafields:", JSON.stringify(allMetafields.map(m => `${m.namespace}:${m.key}`)));

    // Find and delete any addon-bundle related metafields
    const toDelete = allMetafields.filter(mf =>
      mf.namespace.includes('addon') ||
      mf.namespace.includes('bundle') ||
      mf.key.includes('addon') ||
      mf.key.includes('bundle') ||
      mf.key === 'global_config'
    );

    console.log("[clearShopMetafield] Metafields to delete:", JSON.stringify(toDelete));

    if (toDelete.length > 0) {
      const deleteResponse = await admin.graphql(
        `#graphql
        mutation MetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) {
            deletedMetafields {
              ownerId
              namespace
              key
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            metafields: toDelete.map(mf => ({
              ownerId: shopGid,
              namespace: mf.namespace,
              key: mf.key,
            })),
          },
        }
      );

      const deleteResult = await deleteResponse.json();
      console.log("[clearShopMetafield] Delete result:", JSON.stringify(deleteResult, null, 2));

      const deleteData = deleteResult.data as {
        metafieldsDelete?: {
          deletedMetafields?: Array<{ ownerId: string; namespace: string; key: string }>;
          userErrors?: Array<{ field: string; message: string }>;
        };
      };

      if (deleteData?.metafieldsDelete?.userErrors?.length) {
        lastError = deleteData.metafieldsDelete.userErrors.map(e => e.message).join(", ");
        console.error("[clearShopMetafield] User errors:", lastError);
      } else {
        deletedCount = deleteData?.metafieldsDelete?.deletedMetafields?.length || 0;
        console.log("[clearShopMetafield] Deleted", deletedCount, "metafields");
      }
    }
  } catch (error) {
    console.error("[clearShopMetafield] Error listing/deleting metafields:", error);
    lastError = error instanceof Error ? error.message : "Unknown error";
  }

  // Also try direct deletion by ownerId + namespace + key as fallback
  for (const namespace of namespacesToTry) {
    for (const key of keysToTry) {
      try {
        console.log("[clearShopMetafield] Trying direct delete:", shopGid, namespace, key);

        const deleteResponse = await admin.graphql(
          `#graphql
          mutation MetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
            metafieldsDelete(metafields: $metafields) {
              deletedMetafields {
                ownerId
                namespace
                key
              }
              userErrors {
                field
                message
              }
            }
          }`,
          {
            variables: {
              metafields: [{
                ownerId: shopGid,
                namespace: namespace,
                key: key,
              }],
            },
          }
        );

        const deleteResult = await deleteResponse.json();
        const deleteData = deleteResult.data as {
          metafieldsDelete?: {
            deletedMetafields?: Array<{ ownerId: string; namespace: string; key: string }>;
            userErrors?: Array<{ field: string; message: string }>;
          };
        };

        if (deleteData?.metafieldsDelete?.deletedMetafields?.length) {
          console.log("[clearShopMetafield] Direct delete succeeded for:", namespace, key);
          deletedCount += deleteData.metafieldsDelete.deletedMetafields.length;
        }
      } catch (error) {
        // Ignore errors for direct delete attempts
        console.log("[clearShopMetafield] Direct delete failed for", namespace, key, ":", error);
      }
    }
  }

  console.log("[clearShopMetafield] Total deleted:", deletedCount);

  if (deletedCount > 0 || !lastError) {
    return { success: true };
  }

  return { success: false, error: lastError };
}

/**
 * Helper to chunk array into smaller arrays
 */
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}
