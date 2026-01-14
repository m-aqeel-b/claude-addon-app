/**
 * Metafield Sync Service
 * Syncs bundle configuration to Shopify metafields for use by:
 * - Discount Function (reads config to apply discounts)
 * - Theme App Extension (reads config to display widget)
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { BundleWithRelations } from "../models/bundle.server";
import { getAddOnSets } from "../models/addOnSet.server";
import { getWidgetStyle } from "../models/widgetStyle.server";

// Metafield namespace for the app
const METAFIELD_NAMESPACE = "$app:addon-bundle";

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
  addOns: Array<{
    addOnId: string;
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
  style: Record<string, string | number>;
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
 */
export function buildWidgetConfig(
  bundle: BundleWithRelations,
  addOnSets: Awaited<ReturnType<typeof getAddOnSets>>,
  widgetStyle: Awaited<ReturnType<typeof getWidgetStyle>>
): WidgetConfig {
  return {
    bundleId: bundle.id,
    title: bundle.title,
    subtitle: bundle.subtitle,
    selectionMode: bundle.selectionMode,
    targetingType: bundle.targetingType,
    addOns: addOnSets.map((addOn) => ({
      addOnId: addOn.id,
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
 * Sync bundle configuration to product metafields for widget display
 * Called when bundle targeting includes specific products
 */
export async function syncProductMetafields(
  admin: AdminApiContext["admin"],
  productIds: string[],
  widgetConfig: WidgetConfig
): Promise<void> {
  if (productIds.length === 0) return;

  const configJson = JSON.stringify(widgetConfig);

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
    await admin.graphql(
      `#graphql
      mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
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
  }
}

/**
 * Sync bundle configuration to shop metafields for global bundles (ALL_PRODUCTS)
 */
export async function syncShopMetafields(
  admin: AdminApiContext["admin"],
  shopGid: string,
  widgetConfig: WidgetConfig
): Promise<void> {
  await admin.graphql(
    `#graphql
    mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
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
}

/**
 * Clear metafields when bundle is deleted or deactivated
 */
export async function clearProductMetafields(
  admin: AdminApiContext["admin"],
  productIds: string[]
): Promise<void> {
  if (productIds.length === 0) return;

  // First, get the metafield IDs for these products
  const metafieldIds: string[] = [];

  for (const productId of productIds) {
    const response = await admin.graphql(
      `#graphql
      query GetProductMetafield($productId: ID!) {
        product(id: $productId) {
          metafield(namespace: "${METAFIELD_NAMESPACE}", key: "config") {
            id
          }
        }
      }`,
      {
        variables: { productId },
      }
    );

    const data = await response.json();
    if (data.data?.product?.metafield?.id) {
      metafieldIds.push(data.data.product.metafield.id);
    }
  }

  if (metafieldIds.length === 0) return;

  // Delete the metafields
  await admin.graphql(
    `#graphql
    mutation MetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
      metafieldsDelete(metafields: $metafields) {
        deletedMetafields {
          ownerId
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        metafields: metafieldIds.map((id) => ({ id })),
      },
    }
  );
}

/**
 * Clear global shop metafield
 */
export async function clearShopMetafield(
  admin: AdminApiContext["admin"],
  shopGid: string
): Promise<void> {
  const response = await admin.graphql(
    `#graphql
    query GetShopMetafield($shopId: ID!) {
      shop {
        metafield(namespace: "${METAFIELD_NAMESPACE}", key: "global_config") {
          id
        }
      }
    }`,
    {
      variables: { shopId: shopGid },
    }
  );

  const data = await response.json();
  if (!data.data?.shop?.metafield?.id) return;

  await admin.graphql(
    `#graphql
    mutation MetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
      metafieldsDelete(metafields: $metafields) {
        deletedMetafields {
          ownerId
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        metafields: [{ id: data.data.shop.metafield.id }],
      },
    }
  );
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
