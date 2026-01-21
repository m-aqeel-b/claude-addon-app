import { useEffect, useState, useRef, useCallback } from "react";
import { useLoaderData, useFetcher, useNavigate, useParams, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getBundle, updateBundle, deleteBundle, bundleTitleExists } from "../models/bundle.server";
import type { BundleWithRelations } from "../models/bundle.server";
import { getAddOnSets, createAddOnSet, updateAddOnSet, deleteAddOnSet, setVariantsForSet } from "../models/addOnSet.server";
import type { AddOnSetWithVariants } from "../models/addOnSet.server";
import { updateWidgetStyle, resetWidgetStyle, getOrCreateWidgetStyle, getWidgetStyle } from "../models/widgetStyle.server";
import {
  getTargetedItems,
  addTargetedItem,
  removeTargetedItem,
} from "../models/targeting.server";
import {
  buildWidgetConfig,
  syncShopMetafields,
  syncProductMetafields,
  clearShopMetafield,
  clearProductMetafields,
  fetchProductHandles,
} from "../services/metafield.sync";
import {
  activateBundleDiscount,
  deactivateBundleDiscount,
  updateBundleDiscount,
} from "../services/discount.sync";
import type { BundleTargetedItem } from "@prisma/client";
import type {
  BundleStatus,
  SelectionMode,
  TargetingType,
  DiscountCombination,
  DiscountType,
  LayoutType,
  ImageSize,
  DiscountLabelStyle,
  BorderStyle,
  WidgetStyle,
  WidgetTemplate,
} from "@prisma/client";

interface LoaderData {
  bundle: BundleWithRelations;
  addOnSets: AddOnSetWithVariants[];
  widgetStyle: WidgetStyle;
  targetedItems: BundleTargetedItem[];
}

// Admin GraphQL client type
type AdminClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<{
    json: () => Promise<{ data?: Record<string, unknown>; errors?: Array<{ message: string }> }>;
  }>;
};

// Style state type for local management
interface StyleState {
  template: WidgetTemplate;
  backgroundColor: string;
  fontColor: string;
  buttonColor: string;
  buttonTextColor: string;
  discountBadgeColor: string;
  discountTextColor: string;
  borderColor: string;
  fontSize: number;
  titleFontSize: number;
  subtitleFontSize: number;
  layoutType: LayoutType;
  borderRadius: number;
  borderStyle: BorderStyle;
  borderWidth: number;
  padding: number;
  marginTop: number;
  marginBottom: number;
  imageSize: ImageSize;
  discountLabelStyle: DiscountLabelStyle;
  showCountdownTimer: boolean;
}

const defaultStyleState: StyleState = {
  template: "DEFAULT",
  backgroundColor: "#ffffff",
  fontColor: "#000000",
  buttonColor: "#000000",
  buttonTextColor: "#ffffff",
  discountBadgeColor: "#e53935",
  discountTextColor: "#ffffff",
  borderColor: "#e0e0e0",
  fontSize: 14,
  titleFontSize: 18,
  subtitleFontSize: 14,
  layoutType: "LIST",
  borderRadius: 8,
  borderStyle: "SOLID",
  borderWidth: 1,
  padding: 16,
  marginTop: 16,
  marginBottom: 16,
  imageSize: "MEDIUM",
  discountLabelStyle: "BADGE",
  showCountdownTimer: false,
};

// Helper to sync metafields after bundle changes
async function syncBundleMetafields(
  admin: AdminClient,
  bundleId: string,
  shop: string
) {
  console.log("[syncBundleMetafields] Starting sync for bundle:", bundleId);

  try {
    const bundle = await getBundle(bundleId, shop);
    if (!bundle) {
      console.log("[syncBundleMetafields] Bundle not found");
      return;
    }

    console.log("[syncBundleMetafields] Bundle status:", bundle.status, "targeting:", bundle.targetingType);

    // Get shop GID first
    const shopResponse = await admin.graphql(`query { shop { id } }`);
    const shopResult = await shopResponse.json();
    const shopGid = (shopResult.data?.shop as { id?: string })?.id;
    console.log("[syncBundleMetafields] Shop GID:", shopGid);

    // Only sync if bundle is ACTIVE
    if (bundle.status !== "ACTIVE") {
      console.log("[syncBundleMetafields] Bundle not active, clearing metafields if needed");
      // If not active, clear metafields
      if (shopGid && bundle.targetingType === "ALL_PRODUCTS") {
        const clearResult = await clearShopMetafield(admin, shopGid);
        if (!clearResult.success) {
          console.error("[syncBundleMetafields] Failed to clear metafield:", clearResult.error);
        }
      }
      return;
    }

    const [addOnSets, widgetStyle, targetedItems] = await Promise.all([
      getAddOnSets(bundleId),
      getWidgetStyle(bundleId),
      getTargetedItems(bundleId),
    ]);

    console.log("[syncBundleMetafields] AddOnSets:", addOnSets.length, "WidgetStyle:", !!widgetStyle);

    if (!widgetStyle) {
      console.log("[syncBundleMetafields] No widget style found");
      return;
    }

    // Fetch product handles for market-specific pricing in the widget
    const productIds = addOnSets.map((addOn) => addOn.shopifyProductId);
    const productHandles = await fetchProductHandles(admin, productIds);
    console.log("[syncBundleMetafields] Fetched", productHandles.size, "product handles for dynamic pricing");

    const widgetConfig = buildWidgetConfig(bundle, addOnSets, widgetStyle, productHandles);
    console.log("[syncBundleMetafields] Built widget config with", widgetConfig.addOns.length, "add-ons");

    // Sync WIDGET config to shop/product metafields (for theme display)
    if (bundle.targetingType === "ALL_PRODUCTS") {
      // Sync to shop-level metafield for global bundles
      console.log("[syncBundleMetafields] Syncing to shop metafield (ALL_PRODUCTS)");
      if (shopGid) {
        await syncShopMetafields(admin, shopGid, widgetConfig);
      }
    } else if (bundle.targetingType === "SPECIFIC_PRODUCTS") {
      // Sync to specific product metafields
      const productIds = targetedItems
        .filter((item) => item.shopifyResourceType === "Product")
        .map((item) => item.shopifyResourceId);
      console.log("[syncBundleMetafields] Syncing to", productIds.length, "product metafields");
      if (productIds.length > 0) {
        await syncProductMetafields(admin, productIds, widgetConfig);
      }
    }

    // Sync DISCOUNT config to the Shopify discount metafield (for discount function)
    if (bundle.shopifyDiscountId) {
      console.log("[syncBundleMetafields] Syncing discount metafield for discount:", bundle.shopifyDiscountId);
      try {
        const discountResult = await updateBundleDiscount(admin, bundle);
        if (discountResult.errors.length > 0) {
          console.error("[syncBundleMetafields] Discount sync errors:", discountResult.errors);
        } else {
          console.log("[syncBundleMetafields] Discount metafield synced successfully");
        }
      } catch (error) {
        console.error("[syncBundleMetafields] Error syncing discount metafield:", error);
      }
    } else {
      console.log("[syncBundleMetafields] No shopifyDiscountId, skipping discount sync");
    }

    console.log("[syncBundleMetafields] Sync completed for bundle:", bundleId);
  } catch (error) {
    console.error("[syncBundleMetafields] Error syncing metafields:", error);
  }
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const bundleId = params.id!;

  const bundle = await getBundle(bundleId, shop);
  if (!bundle) {
    throw new Response("Bundle not found", { status: 404 });
  }

  const [addOnSetsRaw, widgetStyle, targetedItems] = await Promise.all([
    getAddOnSets(bundleId),
    getOrCreateWidgetStyle(bundleId),
    getTargetedItems(bundleId),
  ]);

  // Convert Decimal fields to numbers for proper JSON serialization
  const addOnSets = addOnSetsRaw.map(addOn => ({
    ...addOn,
    discountValue: addOn.discountValue ? Number(addOn.discountValue) : null,
    selectedVariants: addOn.selectedVariants.map(v => ({
      ...v,
      variantPrice: v.variantPrice ? Number(v.variantPrice) : null,
    })),
  }));

  return { bundle, addOnSets, widgetStyle, targetedItems };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const bundleId = params.id!;

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Bundle update
  if (intent === "updateBundle") {
    const title = formData.get("title") as string;
    const subtitle = formData.get("subtitle") as string;
    const status = formData.get("status") as BundleStatus;
    const startDate = formData.get("startDate") as string;
    const endDate = formData.get("endDate") as string;
    const selectionMode = formData.get("selectionMode") as SelectionMode;
    const targetingType = formData.get("targetingType") as TargetingType;
    const combineWithProductDiscounts = formData.get("combineWithProductDiscounts") as DiscountCombination;
    const combineWithOrderDiscounts = formData.get("combineWithOrderDiscounts") as DiscountCombination;
    const combineWithShippingDiscounts = formData.get("combineWithShippingDiscounts") as DiscountCombination;
    const deleteAddOnsWithMain = formData.get("deleteAddOnsWithMain") === "true";

    const errors: Record<string, string> = {};

    if (!title || title.trim().length === 0) {
      errors.title = "Title is required";
    } else if (title.length > 100) {
      errors.title = "Title must be 100 characters or less";
    } else if (await bundleTitleExists(shop, title, bundleId)) {
      errors.title = "A bundle with this title already exists";
    }

    if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
      errors.endDate = "End date must be after start date";
    }

    if (Object.keys(errors).length > 0) {
      return { errors };
    }

    await updateBundle(bundleId, shop, {
      title: title.trim(),
      subtitle: subtitle.trim() || null,
      status,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      selectionMode,
      targetingType,
      combineWithProductDiscounts,
      combineWithOrderDiscounts,
      combineWithShippingDiscounts,
      deleteAddOnsWithMain,
    });

    // Sync metafields after bundle update
    await syncBundleMetafields(admin, bundleId, shop);

    // Manage Shopify discount based on status
    const updatedBundle = await getBundle(bundleId, shop);
    let discountError: string | null = null;

    if (updatedBundle) {
      try {
        if (status === "ACTIVE") {
          // Create or update the discount when activated
          console.log("[updateBundle] Activating discount for bundle:", bundleId);
          const discountResult = await activateBundleDiscount(admin, shop, updatedBundle);
          if (discountResult.errors.length > 0) {
            console.error("[updateBundle] Discount errors:", discountResult.errors);
            discountError = discountResult.errors.map(e => e.message).join(", ");
          }
        } else {
          // Deactivate (delete) the discount when not active
          console.log("[updateBundle] Deactivating discount for bundle:", bundleId);
          await deactivateBundleDiscount(admin, shop, updatedBundle);
        }
      } catch (error) {
        console.error("[updateBundle] Error managing discount:", error);
        discountError = error instanceof Error ? error.message : "Unknown discount error";
      }
    }

    return { success: true, action: "bundleUpdated", discountError };
  }

  // Save all changes (batch save)
  if (intent === "saveAllChanges") {
    const title = formData.get("title") as string;
    const subtitle = formData.get("subtitle") as string;
    const status = formData.get("status") as BundleStatus;
    const startDate = formData.get("startDate") as string;
    const endDate = formData.get("endDate") as string;
    const selectionMode = formData.get("selectionMode") as SelectionMode;
    const targetingType = formData.get("targetingType") as TargetingType;
    const combineWithProductDiscounts = formData.get("combineWithProductDiscounts") as DiscountCombination;
    const combineWithOrderDiscounts = formData.get("combineWithOrderDiscounts") as DiscountCombination;
    const combineWithShippingDiscounts = formData.get("combineWithShippingDiscounts") as DiscountCombination;
    const deleteAddOnsWithMain = formData.get("deleteAddOnsWithMain") === "true";

    // Parse JSON data for batched changes
    const newTargetedItems = JSON.parse(formData.get("newTargetedItems") as string || "[]");
    const deletedTargetedItemIds = JSON.parse(formData.get("deletedTargetedItemIds") as string || "[]");
    const newAddOnSets = JSON.parse(formData.get("newAddOnSets") as string || "[]");
    const modifiedAddOnSets = JSON.parse(formData.get("modifiedAddOnSets") as string || "[]");
    const deletedAddOnSetIds = JSON.parse(formData.get("deletedAddOnSetIds") as string || "[]");

    // Validation
    const errors: Record<string, string> = {};

    if (!title || title.trim().length === 0) {
      errors.title = "Title is required";
    } else if (title.length > 100) {
      errors.title = "Title must be 100 characters or less";
    } else if (await bundleTitleExists(shop, title, bundleId)) {
      errors.title = "A bundle with this title already exists";
    }

    if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
      errors.endDate = "End date must be after start date";
    }

    if (Object.keys(errors).length > 0) {
      return { errors };
    }

    // 1. Update bundle basic info
    await updateBundle(bundleId, shop, {
      title: title.trim(),
      subtitle: subtitle.trim() || null,
      status,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      selectionMode,
      targetingType,
      combineWithProductDiscounts,
      combineWithOrderDiscounts,
      combineWithShippingDiscounts,
      deleteAddOnsWithMain,
    });

    // 2. Process deleted targeted items
    for (const itemId of deletedTargetedItemIds) {
      await removeTargetedItem(itemId);
    }

    // 3. Process new targeted items
    for (const item of newTargetedItems) {
      await addTargetedItem({
        bundleId,
        shopifyResourceId: item.shopifyResourceId,
        shopifyResourceType: item.shopifyResourceType,
        title: item.title,
        imageUrl: item.imageUrl || null,
      });
    }

    // 4. Process deleted add-on sets
    for (const addOnSetId of deletedAddOnSetIds) {
      await deleteAddOnSet(addOnSetId);
    }

    // 5. Process new add-on sets
    for (const addOn of newAddOnSets) {
      const newAddOnSet = await createAddOnSet({
        bundleId,
        shopifyProductId: addOn.shopifyProductId,
        productTitle: addOn.productTitle,
        productImageUrl: addOn.productImageUrl,
        discountType: addOn.discountType as DiscountType,
        discountValue: addOn.discountValue,
        discountLabel: addOn.discountLabel,
        isDefaultSelected: addOn.isDefaultSelected,
        subscriptionOnly: addOn.subscriptionOnly,
        showQuantitySelector: addOn.showQuantitySelector,
        maxQuantity: addOn.maxQuantity,
      });

      // Create variants for the new add-on
      if (addOn.selectedVariants && addOn.selectedVariants.length > 0) {
        await setVariantsForSet(newAddOnSet.id, addOn.selectedVariants.map((v: { shopifyVariantId: string; variantTitle: string | null; variantSku: string | null; variantPrice: number | null }) => ({
          shopifyVariantId: v.shopifyVariantId,
          variantTitle: v.variantTitle,
          variantSku: v.variantSku,
          variantPrice: v.variantPrice,
        })));
      }
    }

    // 6. Process modified add-on sets
    for (const addOn of modifiedAddOnSets) {
      await updateAddOnSet(addOn.id, {
        // Include product info in case the product was changed
        shopifyProductId: addOn.shopifyProductId,
        productTitle: addOn.productTitle,
        productImageUrl: addOn.productImageUrl,
        // Configuration fields
        discountType: addOn.discountType as DiscountType,
        discountValue: addOn.discountValue,
        discountLabel: addOn.discountLabel,
        isDefaultSelected: addOn.isDefaultSelected,
        subscriptionOnly: addOn.subscriptionOnly,
        showQuantitySelector: addOn.showQuantitySelector,
        maxQuantity: addOn.maxQuantity,
      });

      // Update variants if changed
      if (addOn.selectedVariants) {
        await setVariantsForSet(addOn.id, addOn.selectedVariants.map((v: { shopifyVariantId: string; variantTitle: string | null; variantSku: string | null; variantPrice: number | null }) => ({
          shopifyVariantId: v.shopifyVariantId,
          variantTitle: v.variantTitle,
          variantSku: v.variantSku,
          variantPrice: v.variantPrice,
        })));
      }
    }

    // 7. Sync metafields after all changes
    await syncBundleMetafields(admin, bundleId, shop);

    // 8. Manage Shopify discount based on status
    const updatedBundle = await getBundle(bundleId, shop);
    let discountError: string | null = null;

    if (updatedBundle) {
      try {
        if (status === "ACTIVE") {
          console.log("[saveAllChanges] Activating discount for bundle:", bundleId);
          const discountResult = await activateBundleDiscount(admin, shop, updatedBundle);
          if (discountResult.errors.length > 0) {
            console.error("[saveAllChanges] Discount errors:", discountResult.errors);
            discountError = discountResult.errors.map(e => e.message).join(", ");
          }
        } else {
          console.log("[saveAllChanges] Deactivating discount for bundle:", bundleId);
          await deactivateBundleDiscount(admin, shop, updatedBundle);
        }
      } catch (error) {
        console.error("[saveAllChanges] Error managing discount:", error);
        discountError = error instanceof Error ? error.message : "Unknown discount error";
      }
    }

    return { success: true, action: "bundleUpdated", discountError };
  }

  // Delete bundle
  if (intent === "deleteBundle") {
    console.log("[deleteBundle] Starting delete for bundle:", bundleId);

    // Get the bundle first to check for discount
    const bundleToDelete = await getBundle(bundleId, shop);
    console.log("[deleteBundle] Bundle to delete:", bundleToDelete?.id, "targetingType:", bundleToDelete?.targetingType);

    if (bundleToDelete) {
      // Delete the Shopify discount if it exists
      if (bundleToDelete.shopifyDiscountId) {
        try {
          console.log("[deleteBundle] Deactivating discount:", bundleToDelete.shopifyDiscountId);
          const discountResult = await deactivateBundleDiscount(admin, shop, bundleToDelete);
          console.log("[deleteBundle] Discount deactivation result:", discountResult);
        } catch (error) {
          console.error("[deleteBundle] Error deleting discount:", error);
        }
      }

      // Clear the shop metafield if this was an ALL_PRODUCTS bundle
      if (bundleToDelete.targetingType === "ALL_PRODUCTS") {
        console.log("[deleteBundle] Clearing shop metafield for ALL_PRODUCTS bundle");
        try {
          const shopResponse = await admin.graphql(`query { shop { id } }`);
          const shopResult = await shopResponse.json();
          const shopGid = (shopResult.data?.shop as { id?: string })?.id;
          console.log("[deleteBundle] Shop GID:", shopGid);

          if (shopGid) {
            const metafieldResult = await clearShopMetafield(admin, shopGid);
            console.log("[deleteBundle] Metafield clear result:", metafieldResult);

            if (!metafieldResult.success) {
              console.error("[deleteBundle] Failed to clear metafield:", metafieldResult.error);
            }
          } else {
            console.error("[deleteBundle] Could not get shop GID");
          }
        } catch (error) {
          console.error("[deleteBundle] Error clearing shop metafield:", error);
        }
      }

      // Clear product metafields if this was a SPECIFIC_PRODUCTS bundle
      if (bundleToDelete.targetingType === "SPECIFIC_PRODUCTS") {
        console.log("[deleteBundle] Clearing product metafields for SPECIFIC_PRODUCTS bundle");
        try {
          // Get the targeted product IDs
          const targetedItems = await getTargetedItems(bundleId);
          const productIds = targetedItems
            .filter(item => item.shopifyResourceType === "Product")
            .map(item => item.shopifyResourceId);

          console.log("[deleteBundle] Found", productIds.length, "product metafields to clear");

          if (productIds.length > 0) {
            await clearProductMetafields(admin, productIds);
            console.log("[deleteBundle] Product metafields cleared");
          }
        } catch (error) {
          console.error("[deleteBundle] Error clearing product metafields:", error);
        }
      }
    }

    await deleteBundle(bundleId, shop);
    console.log("[deleteBundle] Bundle deleted from database");
    return { success: true, action: "bundleDeleted", redirect: "/app/bundles" };
  }

  // Add-on set operations
  if (intent === "createAddOnSet") {
    const shopifyProductId = formData.get("shopifyProductId") as string;
    const productTitle = formData.get("productTitle") as string;
    const selectedVariantsJson = formData.get("selectedVariants") as string | null;

    // Check if variants were selected in the picker
    let variants: Array<{
      shopifyVariantId: string;
      variantTitle?: string;
      variantSku?: string;
      variantPrice?: number;
    }> = [];

    let productImageUrl: string | undefined;

    // If variants were passed from the picker, use those
    if (selectedVariantsJson) {
      try {
        const parsedVariants = JSON.parse(selectedVariantsJson) as Array<{
          shopifyVariantId: string;
          variantTitle?: string;
          variantSku?: string | null;
          variantPrice?: number | null;
        }>;
        variants = parsedVariants.map(v => ({
          shopifyVariantId: v.shopifyVariantId,
          variantTitle: v.variantTitle || undefined,
          variantSku: v.variantSku || undefined,
          variantPrice: v.variantPrice || undefined,
        }));
        console.log("[createAddOnSet] Using", variants.length, "variants from picker");
      } catch (e) {
        console.error("[createAddOnSet] Error parsing selectedVariants:", e);
      }
    }

    // Fetch product image (and variants as fallback if none were selected)
    try {
      const productQuery = await admin.graphql(
        `#graphql
        query GetProductVariants($id: ID!) {
          product(id: $id) {
            featuredMedia {
              preview {
                image {
                  url
                }
              }
            }
            variants(first: 100) {
              nodes {
                id
                title
                sku
                price
              }
            }
          }
        }`,
        { variables: { id: shopifyProductId } }
      );

      const productResult = await productQuery.json();
      const productData = productResult.data?.product as {
        featuredMedia?: { preview?: { image?: { url?: string } } };
        variants?: { nodes?: Array<{ id: string; title: string; sku?: string; price?: string }> };
      } | undefined;

      productImageUrl = productData?.featuredMedia?.preview?.image?.url;

      // Only use fetched variants if none were provided from picker
      if (variants.length === 0 && productData?.variants?.nodes) {
        variants = productData.variants.nodes.map((v) => ({
          shopifyVariantId: v.id,
          variantTitle: v.title,
          variantSku: v.sku || undefined,
          variantPrice: v.price ? parseFloat(v.price) : undefined,
        }));
        console.log("[createAddOnSet] Fallback: fetched", variants.length, "variants from API");
      }
    } catch (error) {
      console.error("[createAddOnSet] Error fetching product data:", error);
    }

    // Create the add-on set
    const addOnSet = await createAddOnSet({
      bundleId,
      shopifyProductId,
      productTitle,
      productImageUrl,
    });

    // Add variants to the add-on set
    if (variants.length > 0) {
      await setVariantsForSet(addOnSet.id, variants);
      console.log("[createAddOnSet] Added", variants.length, "variants to add-on set:", addOnSet.id);
    }

    // Sync metafields after add-on created
    await syncBundleMetafields(admin, bundleId, shop);

    return { success: true, action: "addOnCreated" };
  }

  if (intent === "updateAddOnSet") {
    const addOnSetId = formData.get("addOnSetId") as string;
    const discountType = formData.get("discountType") as DiscountType;
    const discountValue = formData.get("discountValue") as string;
    const discountLabel = formData.get("discountLabel") as string;
    const isDefaultSelected = formData.get("isDefaultSelected") === "true";
    const subscriptionOnly = formData.get("subscriptionOnly") === "true";
    const showQuantitySelector = formData.get("showQuantitySelector") === "true";
    const maxQuantity = parseInt(formData.get("maxQuantity") as string) || 10;

    await updateAddOnSet(addOnSetId, {
      discountType,
      discountValue: discountValue ? parseFloat(discountValue) : null,
      discountLabel: discountLabel || null,
      isDefaultSelected,
      subscriptionOnly,
      showQuantitySelector,
      maxQuantity,
    });

    // Sync metafields after add-on updated
    await syncBundleMetafields(admin, bundleId, shop);

    return { success: true, action: "addOnUpdated" };
  }

  if (intent === "deleteAddOnSet") {
    const addOnSetId = formData.get("addOnSetId") as string;
    await deleteAddOnSet(addOnSetId);

    // Sync metafields after add-on deleted
    await syncBundleMetafields(admin, bundleId, shop);

    return { success: true, action: "addOnDeleted" };
  }

  // Fetch all variants for a product (to show in variant selection UI)
  if (intent === "fetchProductVariants") {
    const shopifyProductId = formData.get("shopifyProductId") as string;

    try {
      const productQuery = await admin.graphql(
        `#graphql
        query GetProductVariants($id: ID!) {
          product(id: $id) {
            variants(first: 100) {
              nodes {
                id
                title
                sku
                price
              }
            }
          }
        }`,
        { variables: { id: shopifyProductId } }
      );

      const productResult = await productQuery.json();
      const productData = productResult.data?.product as {
        variants?: { nodes?: Array<{ id: string; title: string; sku?: string; price?: string }> };
      } | undefined;

      const allVariants = productData?.variants?.nodes?.map((v) => ({
        shopifyVariantId: v.id,
        variantTitle: v.title,
        variantSku: v.sku || null,
        variantPrice: v.price ? parseFloat(v.price) : null,
      })) || [];

      return { success: true, action: "variantsFetched", allVariants };
    } catch (error) {
      console.error("[fetchProductVariants] Error:", error);
      return { success: false, errors: { _form: "Failed to fetch variants" } };
    }
  }

  // Update selected variants for an add-on set
  if (intent === "updateAddOnSetVariants") {
    const addOnSetId = formData.get("addOnSetId") as string;
    const selectedVariantsJson = formData.get("selectedVariants") as string;

    try {
      const selectedVariants = JSON.parse(selectedVariantsJson) as Array<{
        shopifyVariantId: string;
        variantTitle?: string;
        variantSku?: string;
        variantPrice?: number;
      }>;

      await setVariantsForSet(addOnSetId, selectedVariants);

      // Sync metafields after variants updated
      await syncBundleMetafields(admin, bundleId, shop);

      return { success: true, action: "variantsUpdated" };
    } catch (error) {
      console.error("[updateAddOnSetVariants] Error:", error);
      return { success: false, errors: { _form: "Failed to update variants" } };
    }
  }

  // Widget style operations
  if (intent === "updateStyle") {
    const styleData = JSON.parse(formData.get("styleData") as string);
    await updateWidgetStyle(bundleId, styleData);

    // Sync metafields after style updated
    await syncBundleMetafields(admin, bundleId, shop);

    return { success: true, action: "styleUpdated" };
  }

  if (intent === "resetStyle") {
    await resetWidgetStyle(bundleId);

    // Sync metafields after style reset
    await syncBundleMetafields(admin, bundleId, shop);

    return { success: true, action: "styleReset" };
  }

  // Targeted items operations (SPECIFIC_PRODUCTS targeting)
  if (intent === "addTargetedItem") {
    const shopifyResourceId = formData.get("shopifyResourceId") as string;
    const shopifyResourceType = formData.get("shopifyResourceType") as "Product" | "Collection";
    const title = formData.get("resourceTitle") as string;
    const imageUrl = formData.get("imageUrl") as string;

    await addTargetedItem({
      bundleId,
      shopifyResourceId,
      shopifyResourceType,
      title,
      imageUrl: imageUrl || undefined,
    });

    // Sync metafields after targeted item added
    await syncBundleMetafields(admin, bundleId, shop);

    return { success: true, action: "targetedItemAdded" };
  }

  if (intent === "removeTargetedItem") {
    const itemId = formData.get("itemId") as string;
    await removeTargetedItem(itemId);

    // Sync metafields after targeted item removed
    await syncBundleMetafields(admin, bundleId, shop);

    return { success: true, action: "targetedItemRemoved" };
  }

  // Manual sync metafields
  if (intent === "syncMetafields") {
    console.log("[Action] Manual metafield sync triggered");
    await syncBundleMetafields(admin, bundleId, shop);
    return { success: true, action: "metafieldsSynced" };
  }

  return { success: false };
};

function formatDateTimeLocal(date: Date | string | null): string {
  if (!date) return "";
  const d = new Date(date);
  return d.toISOString().slice(0, 16);
}

// Local types for tracking changes
interface LocalTargetedItem {
  id: string;
  shopifyResourceId: string;
  shopifyResourceType: "Product" | "Collection";
  title: string;
  imageUrl?: string;
  isNew?: boolean; // Track if this is a new item not yet saved
}

interface LocalAddOnSet {
  id: string;
  shopifyProductId: string;
  productTitle: string | null;
  productImageUrl: string | null;
  discountType: string;
  discountValue: number | null;
  discountLabel: string | null;
  isDefaultSelected: boolean;
  subscriptionOnly: boolean;
  showQuantitySelector: boolean;
  maxQuantity: number;
  selectedVariants: Array<{
    id: string;
    shopifyVariantId: string;
    variantTitle: string | null;
    variantSku: string | null;
    variantPrice: number | null;
  }>;
  isNew?: boolean; // Track if this is a new item not yet saved
  isModified?: boolean; // Track if this item has been modified
}

export default function EditBundle() {
  const { bundle, addOnSets: initialAddOnSets, widgetStyle, targetedItems: initialTargetedItems } = useLoaderData<LoaderData>();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [isStyleModalOpen, setIsStyleModalOpen] = useState(false);
  const [targetedItemToDelete, setTargetedItemToDelete] = useState<LocalTargetedItem | null>(null);
  const [isDeleteBundleModalOpen, setIsDeleteBundleModalOpen] = useState(false);
  const [showEndDate, setShowEndDate] = useState(!!bundle.endDate);

  // Local state for targeted items (changes only saved on Save button click)
  const [localTargetedItems, setLocalTargetedItems] = useState<LocalTargetedItem[]>(
    initialTargetedItems.map(item => ({
      id: item.id,
      shopifyResourceId: item.shopifyResourceId,
      shopifyResourceType: item.shopifyResourceType as "Product" | "Collection",
      title: item.title || "",
      imageUrl: item.imageUrl || undefined,
    }))
  );
  const [deletedTargetedItemIds, setDeletedTargetedItemIds] = useState<string[]>([]);

  // Local state for add-on sets (changes only saved on Save button click)
  const [localAddOnSets, setLocalAddOnSets] = useState<LocalAddOnSet[]>(
    initialAddOnSets.map(addOn => ({
      id: addOn.id,
      shopifyProductId: addOn.shopifyProductId,
      productTitle: addOn.productTitle,
      productImageUrl: addOn.productImageUrl,
      discountType: addOn.discountType,
      discountValue: addOn.discountValue ? Number(addOn.discountValue) : null,
      discountLabel: addOn.discountLabel,
      isDefaultSelected: addOn.isDefaultSelected,
      subscriptionOnly: addOn.subscriptionOnly,
      showQuantitySelector: addOn.showQuantitySelector,
      maxQuantity: addOn.maxQuantity,
      selectedVariants: addOn.selectedVariants.map(v => ({
        id: v.id,
        shopifyVariantId: v.shopifyVariantId,
        variantTitle: v.variantTitle,
        variantSku: v.variantSku,
        variantPrice: v.variantPrice ? Number(v.variantPrice) : null,
      })),
    }))
  );
  const [deletedAddOnSetIds, setDeletedAddOnSetIds] = useState<string[]>([]);

  // Track if there are unsaved changes
  const hasUnsavedChanges =
    deletedTargetedItemIds.length > 0 ||
    deletedAddOnSetIds.length > 0 ||
    localTargetedItems.some(item => item.isNew) ||
    localAddOnSets.some(addOn => addOn.isNew || addOn.isModified);

  // Show toast for bundle creation (redirected from new bundle page)
  useEffect(() => {
    const created = searchParams.get("created");
    const discountError = searchParams.get("discountError");

    if (created === "true") {
      shopify.toast.show("Bundle created successfully");
      // Clean up URL params
      searchParams.delete("created");
      setSearchParams(searchParams, { replace: true });
    } else if (discountError) {
      shopify.toast.show(`Bundle created, but discount error: ${discountError}`, { isError: true });
      // Clean up URL params
      searchParams.delete("discountError");
      setSearchParams(searchParams, { replace: true });
    }
  }, []);

  // Refs for web component buttons
  const saveButtonRef = useRef<HTMLElement>(null);
  const deleteButtonRef = useRef<HTMLElement>(null);
  const syncButtonRef = useRef<HTMLElement>(null);
  const addProductButtonRef = useRef<HTMLElement>(null);
  const stylesButtonRef = useRef<HTMLElement>(null);
  const toggleStatusButtonRef = useRef<HTMLElement>(null);

  const [form, setForm] = useState({
    title: bundle.title,
    subtitle: bundle.subtitle || "",
    status: bundle.status,
    startDate: formatDateTimeLocal(bundle.startDate),
    endDate: formatDateTimeLocal(bundle.endDate),
    selectionMode: bundle.selectionMode,
    targetingType: bundle.targetingType,
    combineWithProductDiscounts: bundle.combineWithProductDiscounts,
    combineWithOrderDiscounts: bundle.combineWithOrderDiscounts,
    combineWithShippingDiscounts: bundle.combineWithShippingDiscounts,
    deleteAddOnsWithMain: bundle.deleteAddOnsWithMain,
  });

  const [style, setStyle] = useState<StyleState>({
    template: widgetStyle.template,
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
    showCountdownTimer: widgetStyle.showCountdownTimer,
  });

  const isSubmitting = fetcher.state === "submitting";
  const errors = fetcher.data?.errors || {};

  useEffect(() => {
    if (fetcher.data?.action === "bundleUpdated") {
      if (fetcher.data.discountError) {
        shopify.toast.show(`Bundle saved & synced, but discount error: ${fetcher.data.discountError}`, { isError: true });
      } else {
        shopify.toast.show("Bundle saved & synced to store");
      }
      // Reset local state tracking after successful save
      setDeletedTargetedItemIds([]);
      setDeletedAddOnSetIds([]);
      // Reset isNew and isModified flags
      setLocalTargetedItems(prev => prev.map(item => ({ ...item, isNew: false })));
      setLocalAddOnSets(prev => prev.map(addOn => ({ ...addOn, isNew: false, isModified: false })));
    } else if (fetcher.data?.action === "bundleDeleted") {
      shopify.toast.show("Bundle deleted");
      navigate("/app/bundles");
    } else if (fetcher.data?.action === "styleUpdated") {
      shopify.toast.show("Styles saved & synced to store");
      setIsStyleModalOpen(false);
    } else if (fetcher.data?.action === "styleReset") {
      shopify.toast.show("Styles reset & synced to store");
      // Update local style state with defaults
      setStyle({
        template: "DEFAULT",
        backgroundColor: "#ffffff",
        fontColor: "#000000",
        buttonColor: "#000000",
        buttonTextColor: "#ffffff",
        discountBadgeColor: "#e53935",
        discountTextColor: "#ffffff",
        borderColor: "#e0e0e0",
        fontSize: 14,
        titleFontSize: 18,
        subtitleFontSize: 14,
        layoutType: "LIST",
        borderRadius: 8,
        borderStyle: "SOLID",
        borderWidth: 1,
        padding: 16,
        marginTop: 16,
        marginBottom: 16,
        imageSize: "MEDIUM",
        discountLabelStyle: "BADGE",
        showCountdownTimer: false,
      });
      setIsStyleModalOpen(false);
    } else if (fetcher.data?.action === "metafieldsSynced") {
      shopify.toast.show("Force synced to store");
    }
  }, [fetcher.data, shopify, navigate]);

  const handleFormChange = (field: string, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleStyleChange = (field: keyof StyleState, value: string | number | boolean) => {
    setStyle((prev) => ({ ...prev, [field]: value }));
  };

  const handleSaveBundle = useCallback(() => {
    // Prepare all changes to be saved
    const newTargetedItems = localTargetedItems.filter(item => item.isNew);
    const newAddOnSets = localAddOnSets.filter(addOn => addOn.isNew);
    const modifiedAddOnSets = localAddOnSets.filter(addOn => addOn.isModified && !addOn.isNew);

    fetcher.submit(
      {
        intent: "saveAllChanges",
        ...form,
        // Convert boolean to string for form submission
        deleteAddOnsWithMain: form.deleteAddOnsWithMain ? "true" : "false",
        // Targeted items changes
        newTargetedItems: JSON.stringify(newTargetedItems),
        deletedTargetedItemIds: JSON.stringify(deletedTargetedItemIds),
        // Add-on sets changes
        newAddOnSets: JSON.stringify(newAddOnSets),
        modifiedAddOnSets: JSON.stringify(modifiedAddOnSets),
        deletedAddOnSetIds: JSON.stringify(deletedAddOnSetIds),
      },
      { method: "POST" }
    );
  }, [fetcher, form, localTargetedItems, localAddOnSets, deletedTargetedItemIds, deletedAddOnSetIds]);

  const handleDeleteBundle = useCallback(() => {
    setIsDeleteBundleModalOpen(true);
  }, []);

  const confirmDeleteBundle = useCallback(() => {
    fetcher.submit({ intent: "deleteBundle" }, { method: "POST" });
    setIsDeleteBundleModalOpen(false);
  }, [fetcher]);

  const handleToggleStatus = useCallback(() => {
    const newStatus = form.status === "ARCHIVED" ? "ACTIVE" : "ARCHIVED";
    setForm((prev) => ({ ...prev, status: newStatus }));
    // Don't auto-save, just update local state - will be saved when user clicks Save
    shopify.toast.show(`Status changed to ${newStatus === "ARCHIVED" ? "Deactivated" : "Active"} - click Save to apply`);
  }, [form, shopify]);

  const handleSaveStyles = useCallback(() => {
    fetcher.submit(
      { intent: "updateStyle", styleData: JSON.stringify(style) },
      { method: "POST" }
    );
  }, [fetcher, style]);

  const handleSyncMetafields = useCallback(() => {
    console.log("Triggering manual metafield sync...");
    fetcher.submit({ intent: "syncMetafields" }, { method: "POST" });
  }, [fetcher]);

  const handleResetStyles = useCallback(() => {
    setStyle(defaultStyleState);
  }, []);

  const handleDeleteAddOn = (addOnSetId: string) => {
    const addOn = localAddOnSets.find(a => a.id === addOnSetId);
    if (addOn?.isNew) {
      // If it's a new item that hasn't been saved yet, just remove from local state
      setLocalAddOnSets(prev => prev.filter(a => a.id !== addOnSetId));
    } else {
      // Mark for deletion (will be deleted when Save is clicked)
      setLocalAddOnSets(prev => prev.filter(a => a.id !== addOnSetId));
      setDeletedAddOnSetIds(prev => [...prev, addOnSetId]);
    }
  };

  const openProductPicker = useCallback(async () => {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: false,
      selectionIds: [],
      filter: { variants: true }, // Enable variant selection in the picker
    });
    if (selected && selected.length > 0) {
      const product = selected[0] as {
        id: string;
        title: string;
        images?: { originalSrc?: string }[];
        variants?: Array<{
          id: string;
          title: string;
          sku?: string;
          price?: string;
        }>;
      };

      // Check if product already exists in local add-ons
      const existingAddOn = localAddOnSets.find(a => a.shopifyProductId === product.id);
      if (existingAddOn) {
        shopify.toast.show("This product is already added as an add-on");
        return;
      }

      // Get the selected variants from the picker (if any)
      const selectedVariants = product.variants || [];

      // Add to local state (will be saved when Save is clicked)
      const newAddOn: LocalAddOnSet = {
        id: `new-${Date.now()}`, // Temporary ID for new items
        shopifyProductId: product.id,
        productTitle: product.title,
        productImageUrl: product.images?.[0]?.originalSrc || null,
        discountType: "PERCENTAGE",
        discountValue: null,
        discountLabel: null,
        isDefaultSelected: false,
        subscriptionOnly: false,
        showQuantitySelector: false,
        maxQuantity: 1,
        selectedVariants: selectedVariants.map(v => ({
          id: `new-variant-${v.id}`,
          shopifyVariantId: v.id,
          variantTitle: v.title,
          variantSku: v.sku || null,
          variantPrice: v.price ? parseFloat(v.price) : null,
        })),
        isNew: true,
      };

      setLocalAddOnSets(prev => [...prev, newAddOn]);
      shopify.toast.show("Add-on added - click Save to apply");
    }
  }, [shopify, localAddOnSets]);

  // Edit variants for an existing add-on (also allows changing the product itself)
  const openVariantEditor = useCallback(async (addOnSetId: string, productId: string, currentVariantIds: string[]) => {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: false,
      selectionIds: [{ id: productId, variants: currentVariantIds.map(id => ({ id })) }],
      filter: { variants: true },
    });

    if (selected && selected.length > 0) {
      const product = selected[0] as {
        id: string;
        title: string;
        images?: { originalSrc?: string }[];
        variants?: Array<{
          id: string;
          title: string;
          sku?: string;
          price?: string;
        }>;
      };

      const selectedVariants = product.variants || [];

      if (selectedVariants.length > 0) {
        // Check if product changed
        const productChanged = product.id !== productId;

        // Update local state (will be saved when Save is clicked)
        setLocalAddOnSets(prev => prev.map(addOn => {
          if (addOn.id === addOnSetId) {
            const updatedAddOn = {
              ...addOn,
              selectedVariants: selectedVariants.map(v => ({
                id: `new-variant-${v.id}`,
                shopifyVariantId: v.id,
                variantTitle: v.title,
                variantSku: v.sku || null,
                variantPrice: v.price ? parseFloat(v.price) : null,
              })),
              isModified: !addOn.isNew, // Mark as modified if not new
            };

            // If product changed, also update product info
            if (productChanged) {
              updatedAddOn.shopifyProductId = product.id;
              updatedAddOn.productTitle = product.title;
              updatedAddOn.productImageUrl = product.images?.[0]?.originalSrc || null;
            }

            return updatedAddOn;
          }
          return addOn;
        }));
        shopify.toast.show(productChanged ? "Product and variants updated - click Save to apply" : "Variants updated - click Save to apply");
      }
    }
  }, [shopify]);

  // Attach event listeners for web component buttons
  useEffect(() => {
    const saveBtn = saveButtonRef.current;
    if (saveBtn) {
      saveBtn.addEventListener("click", handleSaveBundle);
      return () => saveBtn.removeEventListener("click", handleSaveBundle);
    }
  }, [handleSaveBundle]);

  useEffect(() => {
    const deleteBtn = deleteButtonRef.current;
    if (deleteBtn) {
      deleteBtn.addEventListener("click", handleDeleteBundle);
      return () => deleteBtn.removeEventListener("click", handleDeleteBundle);
    }
  }, [handleDeleteBundle]);

  useEffect(() => {
    const toggleBtn = toggleStatusButtonRef.current;
    if (toggleBtn) {
      toggleBtn.addEventListener("click", handleToggleStatus);
      return () => toggleBtn.removeEventListener("click", handleToggleStatus);
    }
  }, [handleToggleStatus]);

  useEffect(() => {
    const syncBtn = syncButtonRef.current;
    if (syncBtn) {
      syncBtn.addEventListener("click", handleSyncMetafields);
      return () => syncBtn.removeEventListener("click", handleSyncMetafields);
    }
  }, [handleSyncMetafields]);

  useEffect(() => {
    const btn = addProductButtonRef.current;
    if (btn) {
      btn.addEventListener("click", openProductPicker);
      return () => btn.removeEventListener("click", openProductPicker);
    }
  }, [openProductPicker]);

  useEffect(() => {
    const btn = stylesButtonRef.current;
    const handler = () => setIsStyleModalOpen(true);
    if (btn) {
      btn.addEventListener("click", handler);
      return () => btn.removeEventListener("click", handler);
    }
  }, []);

  // Targeting handlers
  const openTargetedResourcePicker = async (type: "product" | "collection") => {
    const selected = await shopify.resourcePicker({ type, multiple: true });
    if (selected && selected.length > 0) {
      // Filter out items that are already in the local list
      const existingIds = new Set(localTargetedItems.map(item => item.shopifyResourceId));
      const newItems = selected.filter(resource => !existingIds.has(resource.id));
      const skippedCount = selected.length - newItems.length;

      if (skippedCount > 0) {
        shopify.toast.show(`${skippedCount} item(s) already added, skipped`);
      }

      if (newItems.length > 0) {
        // Add to local state (will be saved when Save is clicked)
        const newLocalItems: LocalTargetedItem[] = newItems.map(resource => ({
          id: `new-${Date.now()}-${resource.id}`,
          shopifyResourceId: resource.id,
          shopifyResourceType: type === "product" ? "Product" : "Collection",
          title: resource.title,
          imageUrl: (resource as { images?: { originalSrc?: string }[] }).images?.[0]?.originalSrc,
          isNew: true,
        }));

        setLocalTargetedItems(prev => [...prev, ...newLocalItems]);
        shopify.toast.show(`${newItems.length} ${type}(s) added - click Save to apply`);
      }
    }
  };

  const handleRemoveTargetedItem = (itemId: string) => {
    const item = localTargetedItems.find(i => i.id === itemId);
    if (item?.isNew) {
      // If it's a new item that hasn't been saved yet, just remove from local state
      setLocalTargetedItems(prev => prev.filter(i => i.id !== itemId));
    } else {
      // Mark for deletion (will be deleted when Save is clicked)
      setLocalTargetedItems(prev => prev.filter(i => i.id !== itemId));
      setDeletedTargetedItemIds(prev => [...prev, itemId]);
    }
  };

  return (
    <s-page
      heading={bundle.title}
      back-action="/app/bundles"
    >
      <s-button
        slot="secondary-actions"
        ref={toggleStatusButtonRef}
      >
        {form.status === "ARCHIVED" ? "Activate" : "Deactivate"}
      </s-button>
      <s-button
        slot="secondary-actions"
        ref={syncButtonRef}
        title="Force sync to store (normally not needed - saves auto-sync)"
      >
        Force Sync
      </s-button>
      <s-button
        slot="secondary-actions"
        ref={deleteButtonRef}
        tone="critical"
      >
        Delete
      </s-button>
      <s-button
        slot="primary-action"
        ref={saveButtonRef}
        variant="primary"
        {...(isSubmitting ? { loading: true } : {})}
      >
        Save
      </s-button>

      {/* Basic Information Section */}
      <s-section heading="Basic information">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Title"
            value={form.title}
            onInput={(e: Event) => handleFormChange("title", (e.target as HTMLInputElement).value)}
            error={errors.title}
            required
          />
          <s-text-field
            label="Subtitle"
            value={form.subtitle}
            onInput={(e: Event) => handleFormChange("subtitle", (e.target as HTMLInputElement).value)}
          />
        </s-stack>
      </s-section>

      {/* Schedule Section */}
      <s-section heading="Schedule">
        <s-stack direction="inline" gap="base">
          <div style={{ flex: 1 }}>
            <s-text variant="bodyMd" style={{ display: "block", marginBottom: "4px" }}>Start date (optional)</s-text>
            <input
              type="datetime-local"
              value={form.startDate}
              onChange={(e) => handleFormChange("startDate", e.target.value)}
              placeholder="mm/dd/yyyy hh:mm"
              style={{
                width: "100%",
                padding: "8px 12px",
                borderRadius: "8px",
                border: "1px solid #8c9196",
                fontSize: "14px",
                backgroundColor: "#fff",
                boxSizing: "border-box",
              }}
            />
          </div>
          <div style={{ flex: 1 }}>
            {!showEndDate ? (
              <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%" }}>
                <s-checkbox
                  checked={showEndDate}
                  onChange={(e: Event) => {
                    const checked = (e.target as HTMLInputElement).checked;
                    setShowEndDate(checked);
                  }}
                  label="Set End Date"
                />
              </div>
            ) : (
              <div>
                <s-text variant="bodyMd" style={{ display: "block", marginBottom: "4px" }}>End date</s-text>
                <input
                  type="datetime-local"
                  value={form.endDate}
                  onChange={(e) => handleFormChange("endDate", e.target.value)}
                  placeholder="mm/dd/yyyy hh:mm"
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    borderRadius: "8px",
                    border: errors.endDate ? "1px solid #d72c0d" : "1px solid #8c9196",
                    fontSize: "14px",
                    backgroundColor: "#fff",
                    boxSizing: "border-box",
                  }}
                />
                {errors.endDate && (
                  <s-text variant="bodySm" color="critical" style={{ marginTop: "4px" }}>{errors.endDate}</s-text>
                )}
                <div style={{ marginTop: "8px" }}>
                  <s-checkbox
                    checked={showEndDate}
                    onChange={(e: Event) => {
                      const checked = (e.target as HTMLInputElement).checked;
                      setShowEndDate(checked);
                      if (!checked) {
                        handleFormChange("endDate", "");
                      }
                    }}
                    label="Set End Date"
                  />
                </div>
              </div>
            )}
          </div>
        </s-stack>
      </s-section>

      {/* Product Targeting Section */}
      <s-section heading="Product targeting">
        <s-stack direction="block" gap="base">
          <s-select
            label="Which products should show this bundle?"
            value={form.targetingType}
            onInput={(e: Event) => handleFormChange("targetingType", (e.target as HTMLSelectElement).value)}
          >
            <s-option value="ALL_PRODUCTS" selected={form.targetingType === "ALL_PRODUCTS"}>All products</s-option>
            <s-option value="SPECIFIC_PRODUCTS" selected={form.targetingType === "SPECIFIC_PRODUCTS"}>Specific products or collections</s-option>
          </s-select>

          {/* Description and targeting UI based on type */}
          {form.targetingType === "ALL_PRODUCTS" && (
            <s-text color="subdued">Add-ons will appear on all product pages.</s-text>
          )}

          {/* Cart behavior checkbox */}
          <s-checkbox
            label="Delete add-on products after Main Product is deleted from cart"
            checked={form.deleteAddOnsWithMain}
            onChange={(e: Event) => handleFormChange("deleteAddOnsWithMain", (e.target as HTMLInputElement).checked)}
          />

          {/* Specific products/collections UI */}
          {form.targetingType === "SPECIFIC_PRODUCTS" && (
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="tight">
                {/* Header row with title and buttons */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <s-text variant="headingSm">Selected products and collections</s-text>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <s-button variant="secondary" onClick={() => openTargetedResourcePicker("product")}>
                      Add product
                    </s-button>
                    <s-button variant="secondary" onClick={() => openTargetedResourcePicker("collection")}>
                      Add collection
                    </s-button>
                  </div>
                </div>
                <s-text color="subdued" variant="bodySm">
                  Add-ons will only appear on these specific products or products in these collections.
                </s-text>

                {localTargetedItems.length === 0 ? (
                  <s-text color="subdued" variant="bodySm">
                    No products or collections selected yet.
                  </s-text>
                ) : (
                  <s-stack direction="block" gap="tight">
                    {localTargetedItems.map((item) => (
                      <s-box key={item.id} padding="base" borderWidth="base" borderRadius="base" background={item.isNew ? "warning" : "default"}>
                        <div style={{ display: "flex", alignItems: "center", gap: "12px", width: "100%" }}>
                          {/* Image */}
                          {item.imageUrl ? (
                            <img
                              src={item.imageUrl}
                              alt={item.title || item.shopifyResourceId}
                              style={{
                                width: "48px",
                                height: "48px",
                                objectFit: "cover",
                                borderRadius: "4px",
                                border: "1px solid #e0e0e0",
                              }}
                            />
                          ) : (
                            <div
                              style={{
                                width: "48px",
                                height: "48px",
                                backgroundColor: "#f5f5f5",
                                borderRadius: "4px",
                                border: "1px solid #e0e0e0",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: "10px",
                                color: "#999",
                              }}
                            >
                              No img
                            </div>
                          )}
                          {/* Title and type badge */}
                          <div style={{ flex: 1 }}>
                            <s-stack direction="block" gap="extraTight">
                              <s-text variant="headingSm">{item.title || item.shopifyResourceId}</s-text>
                              <s-badge tone={item.shopifyResourceType === "Product" ? "info" : "success"}>
                                {item.shopifyResourceType}
                              </s-badge>
                              {item.isNew && <s-badge tone="warning">Unsaved</s-badge>}
                            </s-stack>
                          </div>
                          {/* Remove button - at far right end */}
                          <s-button variant="secondary" tone="critical" onClick={() => setTargetedItemToDelete(item)}>
                            Remove
                          </s-button>
                        </div>
                      </s-box>
                    ))}
                  </s-stack>
                )}
              </s-stack>
            </s-box>
          )}

        </s-stack>
      </s-section>

      {/* Add-ons Section */}
      <s-section heading="Add-on products">
        <s-stack direction="block" gap="base">
          <s-button ref={addProductButtonRef} variant="secondary">
            Add product
          </s-button>

          {localAddOnSets.length === 0 ? (
            <s-box padding="600" textAlign="center">
              <s-stack direction="block" gap="base">
                <s-text>No add-on products yet</s-text>
                <s-text color="subdued">
                  Add products that customers can select as add-ons
                </s-text>
              </s-stack>
            </s-box>
          ) : (
            <s-stack direction="block" gap="base">
              {localAddOnSets.map((addOn) => (
                <AddOnSetCard
                  key={addOn.id}
                  addOn={addOn}
                  isUnsaved={addOn.isNew || addOn.isModified}
                  onDelete={() => handleDeleteAddOn(addOn.id)}
                  onUpdate={(data) => {
                    // Update local state (will be saved when Save is clicked)
                    setLocalAddOnSets(prev => prev.map(a => {
                      if (a.id === addOn.id) {
                        return {
                          ...a,
                          discountType: data.discountType || a.discountType,
                          discountValue: data.discountValue ? parseFloat(data.discountValue) : a.discountValue,
                          discountLabel: data.discountLabel || a.discountLabel,
                          isDefaultSelected: data.isDefaultSelected === "true",
                          subscriptionOnly: data.subscriptionOnly === "true",
                          showQuantitySelector: data.showQuantitySelector === "true",
                          maxQuantity: data.maxQuantity ? parseInt(data.maxQuantity) : a.maxQuantity,
                          isModified: !a.isNew, // Mark as modified if not new
                        };
                      }
                      return a;
                    }));
                    shopify.toast.show("Add-on updated - click Save to apply");
                  }}
                  onEditVariants={() => {
                    openVariantEditor(
                      addOn.id,
                      addOn.shopifyProductId,
                      addOn.selectedVariants.map(v => v.shopifyVariantId)
                    );
                  }}
                />
              ))}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      {/* Styles Section - Aside */}
      <s-section slot="aside" heading="Styles">
        <s-button ref={stylesButtonRef} variant="secondary" style={{ width: '100%' }}>
          Customize Styles
        </s-button>
      </s-section>

      {/* Status Section - Aside */}
      <s-section slot="aside" heading="Status">
        <s-select
          label="Bundle status"
          value={form.status}
          onInput={(e: Event) => handleFormChange("status", (e.target as HTMLSelectElement).value)}
        >
          <s-option value="DRAFT" selected={form.status === "DRAFT"}>Draft</s-option>
          <s-option value="ACTIVE" selected={form.status === "ACTIVE"}>Active</s-option>
          <s-option value="ARCHIVED" selected={form.status === "ARCHIVED"}>Archived</s-option>
        </s-select>
      </s-section>

      {/* Customer Selection Section - Aside */}
      <s-section slot="aside" heading="Customer selection">
        <s-select
          label="Selection mode"
          value={form.selectionMode}
          onInput={(e: Event) => handleFormChange("selectionMode", (e.target as HTMLSelectElement).value)}
        >
          <s-option value="MULTIPLE" selected={form.selectionMode === "MULTIPLE"}>Multiple - Customers can select multiple add-ons</s-option>
          <s-option value="SINGLE" selected={form.selectionMode === "SINGLE"}>Single - Customers can select only one add-on</s-option>
        </s-select>
      </s-section>

      {/* Discount Combinations Section - Aside */}
      <s-section slot="aside" heading="Discount combinations">
        <s-stack direction="block" gap="tight">
          <s-checkbox
            label="Product discounts"
            checked={form.combineWithProductDiscounts === "COMBINE"}
            onChange={(e: Event) => handleFormChange("combineWithProductDiscounts", (e.target as HTMLInputElement).checked ? "COMBINE" : "NOT_COMBINE")}
          />
          <s-checkbox
            label="Order discounts"
            checked={form.combineWithOrderDiscounts === "COMBINE"}
            onChange={(e: Event) => handleFormChange("combineWithOrderDiscounts", (e.target as HTMLInputElement).checked ? "COMBINE" : "NOT_COMBINE")}
          />
          <s-checkbox
            label="Shipping discounts"
            checked={form.combineWithShippingDiscounts === "COMBINE"}
            onChange={(e: Event) => handleFormChange("combineWithShippingDiscounts", (e.target as HTMLInputElement).checked ? "COMBINE" : "NOT_COMBINE")}
          />
        </s-stack>
      </s-section>

      {/* Styles Modal */}
      {isStyleModalOpen && (
        <StylesModal
          style={style}
          onStyleChange={handleStyleChange}
          onClose={() => setIsStyleModalOpen(false)}
          onSave={handleSaveStyles}
          onReset={handleResetStyles}
          bundle={bundle}
          addOnSets={initialAddOnSets}
        />
      )}

      {/* Targeted Item Delete Confirmation Modal */}
      {targetedItemToDelete && (
        <DeleteTargetedItemModal
          item={targetedItemToDelete}
          onConfirm={() => {
            handleRemoveTargetedItem(targetedItemToDelete.id);
            setTargetedItemToDelete(null);
          }}
          onCancel={() => setTargetedItemToDelete(null)}
        />
      )}

      {/* Delete Bundle Confirmation Modal */}
      {isDeleteBundleModalOpen && (
        <DeleteBundleModal
          bundleTitle={bundle.title}
          onConfirm={confirmDeleteBundle}
          onCancel={() => setIsDeleteBundleModalOpen(false)}
        />
      )}
    </s-page>
  );
}

// Styles Modal Component
interface StylesModalProps {
  style: StyleState;
  onStyleChange: (field: keyof StyleState, value: string | number | boolean) => void;
  onClose: () => void;
  onSave: () => void;
  onReset: () => void;
  // Preview data
  bundle: BundleWithRelations;
  addOnSets: AddOnSetWithVariants[];
}

function StylesModal({ style, onStyleChange, onClose, onSave, onReset, bundle, addOnSets }: StylesModalProps) {
  const resetButtonRef = useRef<HTMLElement>(null);
  const saveButtonRef = useRef<HTMLElement>(null);
  const [previewMode, setPreviewMode] = useState<"desktop" | "mobile">("desktop");

  useEffect(() => {
    const resetBtn = resetButtonRef.current;
    if (resetBtn) {
      resetBtn.addEventListener("click", onReset);
      return () => resetBtn.removeEventListener("click", onReset);
    }
  }, [onReset]);

  useEffect(() => {
    const saveBtn = saveButtonRef.current;
    if (saveBtn) {
      saveBtn.addEventListener("click", onSave);
      return () => saveBtn.removeEventListener("click", onSave);
    }
  }, [onSave]);

  const modalOverlayStyle: React.CSSProperties = {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  };

  const modalContentStyle: React.CSSProperties = {
    backgroundColor: "#fff",
    borderRadius: "12px",
    width: "95%",
    maxWidth: "1100px",
    maxHeight: "90vh",
    overflow: "hidden",
    boxShadow: "0 4px 24px rgba(0, 0, 0, 0.2)",
    display: "flex",
    flexDirection: "column",
  };

  const modalHeaderStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "16px 24px",
    borderBottom: "1px solid #e0e0e0",
    backgroundColor: "#fff",
  };

  const modalBodyStyle: React.CSSProperties = {
    display: "flex",
    flex: 1,
    overflow: "hidden",
  };

  const leftPanelStyle: React.CSSProperties = {
    flex: "0 0 400px",
    width: "400px",
    minWidth: "400px",
    padding: "20px 24px",
    overflowY: "auto",
    borderRight: "1px solid #e0e0e0",
  };

  const rightPanelStyle: React.CSSProperties = {
    flex: 1,
    padding: "20px 24px",
    backgroundColor: "#f6f6f7",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  };

  const modalFooterStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    padding: "16px 24px",
    borderTop: "1px solid #e0e0e0",
    backgroundColor: "#fff",
  };

  const colorPickerContainerStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginTop: "4px",
  };

  const colorInputStyle: React.CSSProperties = {
    width: "32px",
    height: "32px",
    padding: "0",
    borderRadius: "6px",
    border: "1px solid #8c9196",
    backgroundColor: "#fff",
    cursor: "pointer",
    flexShrink: 0,
  };

  const colorCodeStyle: React.CSSProperties = {
    fontSize: "13px",
    fontFamily: "monospace",
    color: "#616161",
    textTransform: "uppercase",
  };

  const ColorPicker = ({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <s-text variant="bodySm" color="subdued">{label}</s-text>
      <div style={colorPickerContainerStyle}>
        <input
          type="color"
          style={colorInputStyle}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <span style={colorCodeStyle}>{value}</span>
      </div>
    </div>
  );

  return (
    <div style={modalOverlayStyle} onClick={onClose}>
      <div style={modalContentStyle} onClick={(e) => e.stopPropagation()}>
        <div style={modalHeaderStyle}>
          <s-text variant="headingMd">Widget Styles</s-text>
          <s-button variant="tertiary" onClick={onClose}>✕</s-button>
        </div>

        <div style={modalBodyStyle}>
          {/* Left Panel - Style Controls */}
          <div style={leftPanelStyle}>
            {/* Template Section */}
            <div style={{ marginBottom: "24px" }}>
              <s-select
                label="Select Template"
                value={style.template}
                onInput={(e: Event) => onStyleChange("template", (e.target as HTMLSelectElement).value)}
              >
                <s-option value="DEFAULT" selected={style.template === "DEFAULT"}>Default</s-option>
                <s-option value="MINIMAL" selected={style.template === "MINIMAL"}>Minimal</s-option>
                <s-option value="MODERN" selected={style.template === "MODERN"}>Modern</s-option>
              </s-select>
            </div>

            {/* Colors Section */}
            <div style={{ marginBottom: "24px" }}>
              <s-stack direction="block" gap="tight">
                <s-text variant="headingSm">Colors</s-text>
                <s-stack direction="inline" gap="base">
                  <ColorPicker label="Background" value={style.backgroundColor} onChange={(v) => onStyleChange("backgroundColor", v)} />
                  <ColorPicker label="Font" value={style.fontColor} onChange={(v) => onStyleChange("fontColor", v)} />
                </s-stack>
                <s-stack direction="inline" gap="base">
                  <ColorPicker label="Button" value={style.buttonColor} onChange={(v) => onStyleChange("buttonColor", v)} />
                  <ColorPicker label="Button text" value={style.buttonTextColor} onChange={(v) => onStyleChange("buttonTextColor", v)} />
                </s-stack>
                <s-stack direction="inline" gap="base">
                  <ColorPicker label="Discount badge" value={style.discountBadgeColor} onChange={(v) => onStyleChange("discountBadgeColor", v)} />
                  <ColorPicker label="Discount text" value={style.discountTextColor} onChange={(v) => onStyleChange("discountTextColor", v)} />
                </s-stack>
                <s-stack direction="inline" gap="base">
                  <ColorPicker label="Border" value={style.borderColor} onChange={(v) => onStyleChange("borderColor", v)} />
                  <div style={{ flex: 1 }}></div>
                </s-stack>
              </s-stack>
            </div>

            {/* Layout Section */}
            <div style={{ marginBottom: "24px" }}>
              <s-stack direction="block" gap="base">
                <s-text variant="headingSm">Layout</s-text>
                <s-stack direction="inline" gap="base">
                  <div style={{ flex: 1 }}>
                    <s-select
                      label="Layout type"
                      value={style.layoutType}
                      onInput={(e: Event) => onStyleChange("layoutType", (e.target as HTMLSelectElement).value)}
                    >
                      <s-option value="LIST" selected={style.layoutType === "LIST"}>List</s-option>
                      <s-option value="GRID" selected={style.layoutType === "GRID"}>Grid</s-option>
                    </s-select>
                  </div>
                  <div style={{ flex: 1 }}>
                    <s-select
                      label="Image size"
                      value={style.imageSize}
                      onInput={(e: Event) => onStyleChange("imageSize", (e.target as HTMLSelectElement).value)}
                    >
                      <s-option value="SMALL" selected={style.imageSize === "SMALL"}>Small</s-option>
                      <s-option value="MEDIUM" selected={style.imageSize === "MEDIUM"}>Medium</s-option>
                      <s-option value="LARGE" selected={style.imageSize === "LARGE"}>Large</s-option>
                    </s-select>
                  </div>
                </s-stack>
                <s-stack direction="inline" gap="base">
                  <div style={{ flex: 1 }}>
                    <s-select
                      label="Discount label style"
                      value={style.discountLabelStyle}
                      onInput={(e: Event) => onStyleChange("discountLabelStyle", (e.target as HTMLSelectElement).value)}
                    >
                      <s-option value="BADGE" selected={style.discountLabelStyle === "BADGE"}>Badge</s-option>
                      <s-option value="HIGHLIGHTED_TEXT" selected={style.discountLabelStyle === "HIGHLIGHTED_TEXT"}>Highlighted text</s-option>
                    </s-select>
                  </div>
                  <div style={{ flex: 1 }}></div>
                </s-stack>
                <s-checkbox
                  label="Display countdown timer"
                  {...(style.showCountdownTimer ? { checked: true } : {})}
                  onChange={(e: Event) => onStyleChange("showCountdownTimer", (e.target as HTMLInputElement).checked)}
                />
              </s-stack>
            </div>

            {/* Typography Section */}
            <div style={{ marginBottom: "24px" }}>
              <s-stack direction="block" gap="base">
                <s-text variant="headingSm">Typography</s-text>
                <s-stack direction="inline" gap="base">
                  <div style={{ flex: 1 }}>
                    <s-text-field
                      label="Title font size (px)"
                      type="number"
                      value={style.titleFontSize.toString()}
                      onInput={(e: Event) => onStyleChange("titleFontSize", parseInt((e.target as HTMLInputElement).value) || 18)}
                      min="10"
                      max="32"
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <s-text-field
                      label="Subtitle font size (px)"
                      type="number"
                      value={style.subtitleFontSize.toString()}
                      onInput={(e: Event) => onStyleChange("subtitleFontSize", parseInt((e.target as HTMLInputElement).value) || 14)}
                      min="10"
                      max="24"
                    />
                  </div>
                </s-stack>
                <s-stack direction="inline" gap="base">
                  <div style={{ flex: 1 }}>
                    <s-text-field
                      label="Body font size (px)"
                      type="number"
                      value={style.fontSize.toString()}
                      onInput={(e: Event) => onStyleChange("fontSize", parseInt((e.target as HTMLInputElement).value) || 14)}
                      min="10"
                      max="20"
                    />
                  </div>
                  <div style={{ flex: 1 }}></div>
                </s-stack>
              </s-stack>
            </div>

            {/* Spacing & Borders Section */}
            <div style={{ marginBottom: "24px" }}>
              <s-stack direction="block" gap="base">
                <s-text variant="headingSm">Spacing & Borders</s-text>
                <s-stack direction="inline" gap="base">
                  <div style={{ flex: 1 }}>
                    <s-text-field
                      label="Border radius (px)"
                      type="number"
                      value={style.borderRadius.toString()}
                      onInput={(e: Event) => onStyleChange("borderRadius", parseInt((e.target as HTMLInputElement).value) || 0)}
                      min="0"
                      max="24"
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <s-select
                      label="Border style"
                      value={style.borderStyle}
                      onInput={(e: Event) => onStyleChange("borderStyle", (e.target as HTMLSelectElement).value)}
                    >
                      <s-option value="NONE" selected={style.borderStyle === "NONE"}>None</s-option>
                      <s-option value="SOLID" selected={style.borderStyle === "SOLID"}>Solid</s-option>
                      <s-option value="DASHED" selected={style.borderStyle === "DASHED"}>Dashed</s-option>
                      <s-option value="DOTTED" selected={style.borderStyle === "DOTTED"}>Dotted</s-option>
                    </s-select>
                  </div>
                </s-stack>
                <s-stack direction="inline" gap="base">
                  <div style={{ flex: 1 }}>
                    <s-text-field
                      label="Border width (px)"
                      type="number"
                      value={style.borderWidth.toString()}
                      onInput={(e: Event) => onStyleChange("borderWidth", parseInt((e.target as HTMLInputElement).value) || 0)}
                      min="0"
                      max="5"
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <s-text-field
                      label="Padding (px)"
                      type="number"
                      value={style.padding.toString()}
                      onInput={(e: Event) => onStyleChange("padding", parseInt((e.target as HTMLInputElement).value) || 0)}
                      min="0"
                      max="48"
                    />
                  </div>
                </s-stack>
                <s-stack direction="inline" gap="base">
                  <div style={{ flex: 1 }}>
                    <s-text-field
                      label="Margin top (px)"
                      type="number"
                      value={style.marginTop.toString()}
                      onInput={(e: Event) => onStyleChange("marginTop", parseInt((e.target as HTMLInputElement).value) || 0)}
                      min="0"
                      max="64"
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <s-text-field
                      label="Margin bottom (px)"
                      type="number"
                      value={style.marginBottom.toString()}
                      onInput={(e: Event) => onStyleChange("marginBottom", parseInt((e.target as HTMLInputElement).value) || 0)}
                      min="0"
                      max="64"
                    />
                  </div>
                </s-stack>
              </s-stack>
            </div>
          </div>

          {/* Right Panel - Live Preview */}
          <div style={rightPanelStyle}>
            <div style={{ marginBottom: "12px", flexShrink: 0, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <s-text variant="headingSm">Live Preview</s-text>
                <s-text variant="bodySm" color="subdued">See how your widget will look</s-text>
              </div>
              {/* Desktop/Mobile Toggle */}
              <div style={{ display: "flex", gap: "4px", backgroundColor: "#e0e0e0", borderRadius: "8px", padding: "4px" }}>
                <button
                  onClick={() => setPreviewMode("desktop")}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: "36px",
                    height: "32px",
                    border: "none",
                    borderRadius: "6px",
                    backgroundColor: previewMode === "desktop" ? "#fff" : "transparent",
                    cursor: "pointer",
                    boxShadow: previewMode === "desktop" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                  }}
                  title="Desktop view"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={previewMode === "desktop" ? "#000" : "#666"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                    <line x1="8" y1="21" x2="16" y2="21"></line>
                    <line x1="12" y1="17" x2="12" y2="21"></line>
                  </svg>
                </button>
                <button
                  onClick={() => setPreviewMode("mobile")}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: "36px",
                    height: "32px",
                    border: "none",
                    borderRadius: "6px",
                    backgroundColor: previewMode === "mobile" ? "#fff" : "transparent",
                    cursor: "pointer",
                    boxShadow: previewMode === "mobile" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                  }}
                  title="Mobile view"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={previewMode === "mobile" ? "#000" : "#666"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect>
                    <line x1="12" y1="18" x2="12.01" y2="18"></line>
                  </svg>
                </button>
              </div>
            </div>
            <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", paddingBottom: "16px", display: "flex", justifyContent: "center" }}>
              <div style={{
                width: previewMode === "mobile" ? "375px" : "100%",
                maxWidth: "100%",
                boxSizing: "border-box",
                transition: "width 0.3s ease",
              }}>
                <StylesModalPreview
                  bundle={bundle}
                  addOnSets={addOnSets}
                  style={style}
                />
              </div>
            </div>
          </div>
        </div>

        <div style={modalFooterStyle}>
          <s-button ref={resetButtonRef} variant="secondary">
            Reset to defaults
          </s-button>
          <s-button ref={saveButtonRef} variant="primary">
            Save Styles
          </s-button>
        </div>
      </div>
    </div>
  );
}

// Preview component for inside the styles modal
interface StylesModalPreviewProps {
  bundle: BundleWithRelations;
  addOnSets: AddOnSetWithVariants[];
  style: StyleState;
}

function StylesModalPreview({ bundle, addOnSets, style }: StylesModalPreviewProps) {
  // Countdown timer state
  const [countdownValues, setCountdownValues] = useState({ days: "00", hours: "00", minutes: "00", seconds: "00" });
  const [isExpired, setIsExpired] = useState(false);

  useEffect(() => {
    if (!style.showCountdownTimer || !bundle.endDate) {
      return;
    }

    const calculateCountdown = () => {
      const endTime = new Date(bundle.endDate!).getTime();
      const now = Date.now();
      const diff = endTime - now;

      if (diff <= 0) {
        setIsExpired(true);
        setCountdownValues({ days: "00", hours: "00", minutes: "00", seconds: "00" });
        return;
      }

      setIsExpired(false);
      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);

      setCountdownValues({
        days: String(days).padStart(2, '0'),
        hours: String(hours).padStart(2, '0'),
        minutes: String(minutes).padStart(2, '0'),
        seconds: String(seconds).padStart(2, '0'),
      });
    };

    calculateCountdown();
    const interval = setInterval(calculateCountdown, 1000);
    return () => clearInterval(interval);
  }, [style.showCountdownTimer, bundle.endDate]);

  // Get image size in pixels
  const getImageSize = () => {
    switch (style.imageSize) {
      case "SMALL": return 50;
      case "LARGE": return 120;
      default: return 80;
    }
  };
  const imageSize = getImageSize();

  // Calculate discounted price
  const calculateDiscountedPrice = (originalPrice: number, discountType: string, discountValue: number | null) => {
    if (!discountValue && discountType !== "FREE_GIFT") return originalPrice;

    switch (discountType) {
      case "PERCENTAGE":
        return originalPrice - (originalPrice * (discountValue || 0) / 100);
      case "FIXED_AMOUNT":
        return Math.max(0, originalPrice - (discountValue || 0));
      case "FIXED_PRICE":
        return discountValue || 0;
      case "FREE_GIFT":
        return 0;
      default:
        return originalPrice;
    }
  };

  // Get discount badge text
  const getDiscountBadge = (addOn: AddOnSetWithVariants) => {
    if (addOn.discountType === "FREE_GIFT") return "FREE";
    if (addOn.discountLabel) return addOn.discountLabel;
    if (addOn.discountType === "PERCENTAGE" && addOn.discountValue) return `${addOn.discountValue}% OFF`;
    if (addOn.discountType === "FIXED_AMOUNT" && addOn.discountValue) return `$${addOn.discountValue} OFF`;
    return null;
  };

  const previewStyle: React.CSSProperties = {
    backgroundColor: style.backgroundColor,
    color: style.fontColor,
    borderRadius: `${style.borderRadius}px`,
    borderStyle: style.borderStyle === "NONE" ? "none" : style.borderStyle.toLowerCase(),
    borderWidth: `${style.borderWidth}px`,
    borderColor: style.borderColor,
    padding: `${style.padding}px`,
    fontSize: `${style.fontSize}px`,
    width: "100%",
    maxWidth: "100%",
    boxSizing: "border-box",
    overflow: "hidden",
  };

  const titleStyle: React.CSSProperties = {
    fontSize: `${style.titleFontSize}px`,
    fontWeight: 600,
    marginBottom: "8px",
    lineHeight: 1.3,
  };

  const subtitleStyle: React.CSSProperties = {
    fontSize: `${style.subtitleFontSize}px`,
    opacity: 0.8,
    marginBottom: "16px",
    lineHeight: 1.4,
  };

  const countdownContainerStyle: React.CSSProperties = {
    marginBottom: "16px",
  };

  const countdownStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    background: `linear-gradient(135deg, ${style.discountBadgeColor} 0%, ${style.discountBadgeColor}cc 100%)`,
    padding: "12px 20px",
    borderRadius: "8px",
    opacity: isExpired ? 0.6 : 1,
  };

  const countdownItemStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    minWidth: "45px",
  };

  const countdownValueStyle: React.CSSProperties = {
    fontSize: "1.5em",
    fontWeight: 700,
    color: style.discountTextColor,
    lineHeight: 1,
    fontVariantNumeric: "tabular-nums",
  };

  const countdownLabelStyle: React.CSSProperties = {
    fontSize: "0.7em",
    color: style.discountTextColor,
    opacity: 0.9,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    marginTop: "4px",
  };

  const countdownSeparatorStyle: React.CSSProperties = {
    fontSize: "1.5em",
    fontWeight: 700,
    color: style.discountTextColor,
    opacity: 0.7,
    lineHeight: 1,
    marginBottom: "16px",
  };

  const badgeStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: "3px 8px",
    backgroundColor: style.discountBadgeColor,
    color: style.discountTextColor,
    fontSize: "0.7em",
    fontWeight: 700,
    borderRadius: "4px",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    whiteSpace: "nowrap",
  };

  const freeBadgeStyle: React.CSSProperties = {
    ...badgeStyle,
    backgroundColor: "#27ae60",
  };

  return (
    <div style={previewStyle}>
      {/* Title */}
      {bundle.title && <div style={titleStyle}>{bundle.title}</div>}

      {/* Subtitle */}
      {bundle.subtitle && <div style={subtitleStyle}>{bundle.subtitle}</div>}

      {/* Countdown Timer */}
      {style.showCountdownTimer && (
        <div style={countdownContainerStyle}>
          {bundle.endDate ? (
            <div style={countdownStyle}>
              <div style={countdownItemStyle}>
                <span style={countdownValueStyle}>{countdownValues.days}</span>
                <span style={countdownLabelStyle}>Days</span>
              </div>
              <span style={countdownSeparatorStyle}>:</span>
              <div style={countdownItemStyle}>
                <span style={countdownValueStyle}>{countdownValues.hours}</span>
                <span style={countdownLabelStyle}>Hours</span>
              </div>
              <span style={countdownSeparatorStyle}>:</span>
              <div style={countdownItemStyle}>
                <span style={countdownValueStyle}>{countdownValues.minutes}</span>
                <span style={countdownLabelStyle}>Mins</span>
              </div>
              <span style={countdownSeparatorStyle}>:</span>
              <div style={countdownItemStyle}>
                <span style={countdownValueStyle}>{countdownValues.seconds}</span>
                <span style={countdownLabelStyle}>Secs</span>
              </div>
            </div>
          ) : (
            <div style={{ ...countdownStyle, opacity: 0.5 }}>
              <span style={{ color: style.discountTextColor, fontStyle: "italic" }}>
                Set an end date to show countdown
              </span>
            </div>
          )}
        </div>
      )}

      {/* Add-On List */}
      {addOnSets.length === 0 ? (
        <div style={{ opacity: 0.6, textAlign: "center", padding: "20px" }}>
          No add-ons configured
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: style.layoutType === "GRID" ? "row" : "column", gap: "12px", flexWrap: "wrap" }}>
          {addOnSets.slice(0, 3).map((addOn) => {
            const firstVariant = addOn.selectedVariants?.[0];
            const originalPrice = firstVariant?.variantPrice ? Number(firstVariant.variantPrice) : null;
            const hasDiscount = addOn.discountType !== "PERCENTAGE" || (addOn.discountValue && addOn.discountValue > 0);
            const discountedPrice = originalPrice !== null ? calculateDiscountedPrice(originalPrice, addOn.discountType, addOn.discountValue ? Number(addOn.discountValue) : null) : null;
            const discountBadge = getDiscountBadge(addOn);

            return (
              <div
                key={addOn.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                  padding: "12px",
                  backgroundColor: "rgba(0,0,0,0.03)",
                  borderRadius: `${Math.max(4, style.borderRadius / 2)}px`,
                  flex: style.layoutType === "GRID" ? "1 1 45%" : "none",
                }}
              >
                {/* Checkbox */}
                <div style={{
                  flexShrink: 0,
                  width: "20px",
                  height: "20px",
                  border: `2px solid ${style.fontColor}`,
                  borderRadius: bundle.selectionMode === "SINGLE" ? "50%" : "4px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: addOn.isDefaultSelected ? style.buttonColor : "transparent",
                }}>
                  {addOn.isDefaultSelected && (
                    <div style={{
                      width: bundle.selectionMode === "SINGLE" ? "8px" : "10px",
                      height: bundle.selectionMode === "SINGLE" ? "8px" : "10px",
                      backgroundColor: style.buttonTextColor,
                      borderRadius: bundle.selectionMode === "SINGLE" ? "50%" : "2px",
                    }} />
                  )}
                </div>

                {/* Product Image */}
                <div style={{
                  flexShrink: 0,
                  width: `${imageSize}px`,
                  height: `${imageSize}px`,
                  borderRadius: "6px",
                  overflow: "hidden",
                  backgroundColor: "rgba(0,0,0,0.05)",
                }}>
                  {addOn.productImageUrl ? (
                    <img
                      src={addOn.productImageUrl}
                      alt={addOn.productTitle || ""}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  ) : (
                    <div style={{
                      width: "100%",
                      height: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "linear-gradient(135deg, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.1) 100%)",
                    }}>
                      <svg width="40%" height="40%" viewBox="0 0 24 24" fill="none" stroke="rgba(0,0,0,0.25)" strokeWidth="1.5">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                        <circle cx="8.5" cy="8.5" r="1.5"/>
                        <polyline points="21 15 16 10 5 21"/>
                      </svg>
                    </div>
                  )}
                </div>

                {/* Content */}
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "6px", minWidth: 0 }}>
                  {/* Title Row */}
                  <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
                    <span style={{ fontWeight: 600, fontSize: "1em", lineHeight: 1.3 }}>
                      {addOn.title || addOn.productTitle || "Product"}
                    </span>
                    {discountBadge && (
                      <span style={addOn.discountType === "FREE_GIFT" ? freeBadgeStyle : badgeStyle}>
                        {discountBadge}
                      </span>
                    )}
                  </div>

                  {/* Price Row */}
                  {originalPrice !== null && (
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                      {hasDiscount && discountedPrice !== originalPrice ? (
                        <>
                          <span style={{ textDecoration: "line-through", color: "rgba(0,0,0,0.5)", fontSize: "0.85em" }}>
                            ${originalPrice.toFixed(2)}
                          </span>
                          <span style={{ fontWeight: 700, color: "#27ae60", fontSize: "1.05em" }}>
                            {discountedPrice === 0 ? "FREE" : `$${discountedPrice.toFixed(2)}`}
                          </span>
                        </>
                      ) : (
                        <span style={{ fontSize: "0.95em", fontWeight: 500 }}>
                          ${originalPrice.toFixed(2)}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {addOnSets.length > 3 && (
            <div style={{ opacity: 0.6, fontSize: "12px" }}>
              +{addOnSets.length - 3} more add-ons
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Add-On Set Card Component
interface AddOnSetCardProps {
  addOn: LocalAddOnSet;
  isUnsaved?: boolean;
  onDelete: () => void;
  onUpdate: (data: Record<string, string>) => void;
  onEditVariants: () => void;
}

function AddOnSetCard({ addOn, isUnsaved, onDelete, onUpdate, onEditVariants }: AddOnSetCardProps) {
  const [isConfigureModalOpen, setIsConfigureModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);

  const productImageStyle: React.CSSProperties = {
    width: "50px",
    height: "50px",
    objectFit: "cover",
    borderRadius: "6px",
    backgroundColor: "#f1f1f1",
  };

  const placeholderImageStyle: React.CSSProperties = {
    ...productImageStyle,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#8c9196",
    fontSize: "10px",
  };

  const discountBadgeStyle: React.CSSProperties = {
    backgroundColor: "#e4f3e5",
    color: "#1a7f37",
    padding: "4px 10px",
    borderRadius: "6px",
    fontSize: "13px",
    fontWeight: 500,
    whiteSpace: "nowrap",
  };

  // Format discount display text
  const getDiscountText = () => {
    if (addOn.discountType === "FREE_GIFT") {
      return "Free gift";
    }
    if (addOn.discountType === "PERCENTAGE" && addOn.discountValue) {
      return `Percentage discount: ${addOn.discountValue}%`;
    }
    if (addOn.discountType === "FIXED_AMOUNT" && addOn.discountValue) {
      return `Fixed amount off: $${addOn.discountValue}`;
    }
    if (addOn.discountType === "FIXED_PRICE" && addOn.discountValue) {
      return `Fixed price: $${addOn.discountValue}`;
    }
    return "No discount";
  };

  return (
    <>
      <s-box padding="base" borderWidth="base" borderRadius="base">
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {/* Product Image */}
          {addOn.productImageUrl ? (
            <img src={addOn.productImageUrl} alt={addOn.productTitle || ""} style={productImageStyle} />
          ) : (
            <div style={placeholderImageStyle}>No image</div>
          )}

          {/* Product Title and Discount Info */}
          <div style={{ flex: 1 }}>
            <s-text variant="headingSm">{addOn.productTitle || "Untitled product"}</s-text>
            <div style={{ marginTop: "4px", display: "flex", gap: "8px", alignItems: "center" }}>
              <span style={discountBadgeStyle}>{getDiscountText()}</span>
              {isUnsaved && <s-badge tone="warning">Unsaved</s-badge>}
            </div>
          </div>

          {/* Action Buttons - Right Side */}
          <div style={{ display: "flex", gap: "10px", marginLeft: "auto" }}>
            <s-button variant="secondary" onClick={() => setIsConfigureModalOpen(true)}>
              Configure
            </s-button>
            <s-button variant="secondary" tone="critical" onClick={() => setIsDeleteModalOpen(true)}>
              Remove
            </s-button>
          </div>
        </div>
      </s-box>

      {/* Configure Modal */}
      {isConfigureModalOpen && (
        <ConfigureAddOnSetModal
          addOn={addOn}
          onUpdate={onUpdate}
          onEditVariants={onEditVariants}
          onClose={() => setIsConfigureModalOpen(false)}
        />
      )}

      {/* Delete Confirmation Modal */}
      {isDeleteModalOpen && (
        <DeleteAddOnConfirmModal
          productTitle={addOn.productTitle || ""}
          onConfirm={() => {
            onDelete();
            setIsDeleteModalOpen(false);
          }}
          onCancel={() => setIsDeleteModalOpen(false)}
        />
      )}
    </>
  );
}

// Configure Add-On Set Modal Component
interface ConfigureAddOnSetModalProps {
  addOn: LocalAddOnSet;
  onUpdate: (data: Record<string, string>) => void;
  onEditVariants: () => void;
  onClose: () => void;
}

function ConfigureAddOnSetModal({ addOn, onUpdate, onEditVariants, onClose }: ConfigureAddOnSetModalProps) {
  const [discountType, setDiscountType] = useState(addOn.discountType);
  const [discountValue, setDiscountValue] = useState(addOn.discountValue?.toString() || "");
  const [discountLabel, setDiscountLabel] = useState(addOn.discountLabel || "");
  const [isDefaultSelected, setIsDefaultSelected] = useState(addOn.isDefaultSelected);
  const [subscriptionOnly, setSubscriptionOnly] = useState(addOn.subscriptionOnly);
  const [showQuantitySelector, setShowQuantitySelector] = useState(addOn.showQuantitySelector);
  const [maxQuantity, setMaxQuantity] = useState(addOn.maxQuantity);

  const handleSave = () => {
    onUpdate({
      discountType,
      discountValue,
      discountLabel,
      isDefaultSelected: String(isDefaultSelected),
      subscriptionOnly: String(subscriptionOnly),
      showQuantitySelector: String(showQuantitySelector),
      maxQuantity: String(maxQuantity),
    });
    onClose();
  };

  const modalOverlayStyle: React.CSSProperties = {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  };

  const modalContentStyle: React.CSSProperties = {
    backgroundColor: "#fff",
    borderRadius: "12px",
    width: "90%",
    maxWidth: "500px",
    maxHeight: "85vh",
    overflow: "hidden",
    boxShadow: "0 4px 24px rgba(0, 0, 0, 0.2)",
    display: "flex",
    flexDirection: "column",
  };

  const modalHeaderStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "16px 20px",
    borderBottom: "1px solid #e0e0e0",
  };

  const modalBodyStyle: React.CSSProperties = {
    padding: "20px",
    overflowY: "auto",
    flex: 1,
  };

  const modalFooterStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "flex-end",
    gap: "12px",
    padding: "16px 20px",
    borderTop: "1px solid #e0e0e0",
  };

  return (
    <div style={modalOverlayStyle} onClick={onClose}>
      <div style={modalContentStyle} onClick={(e) => e.stopPropagation()}>
        <div style={modalHeaderStyle}>
          <s-text variant="headingMd">Configure Add-On</s-text>
          <s-button variant="tertiary" onClick={onClose}>✕</s-button>
        </div>

        <div style={modalBodyStyle}>
          <s-stack direction="block" gap="base">
            {/* Product Info with Variants */}
            <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
              {addOn.productImageUrl ? (
                <img
                  src={addOn.productImageUrl}
                  alt={addOn.productTitle || ""}
                  style={{ width: "60px", height: "60px", objectFit: "cover", borderRadius: "8px" }}
                />
              ) : (
                <div style={{ width: "60px", height: "60px", backgroundColor: "#f1f1f1", borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", color: "#8c9196", fontSize: "10px" }}>
                  No image
                </div>
              )}
              <div style={{ flex: 1 }}>
                <s-text variant="headingSm">{addOn.productTitle || "Untitled product"}</s-text>
                <div style={{ marginTop: "6px" }}>
                  <s-badge tone="info">{addOn.selectedVariants.length} variant(s) selected</s-badge>
                </div>
              </div>
              <s-button variant="secondary" onClick={onEditVariants}>
                Edit variants
              </s-button>
            </div>

            {/* Discount Type */}
            <s-select
              label="Discount type"
              value={discountType}
              onInput={(e: Event) => setDiscountType((e.target as HTMLSelectElement).value as DiscountType)}
            >
              <s-option value="PERCENTAGE" selected={discountType === "PERCENTAGE"}>Percentage</s-option>
              <s-option value="FIXED_AMOUNT" selected={discountType === "FIXED_AMOUNT"}>Fixed amount off</s-option>
              <s-option value="FIXED_PRICE" selected={discountType === "FIXED_PRICE"}>Fixed price</s-option>
              <s-option value="FREE_GIFT" selected={discountType === "FREE_GIFT"}>Free gift (100% off)</s-option>
            </s-select>

            {/* Discount Value */}
            {discountType !== "FREE_GIFT" && (
              <s-text-field
                label={discountType === "PERCENTAGE" ? "Discount percentage" : "Discount amount"}
                type="number"
                value={discountValue}
                onInput={(e: Event) => setDiscountValue((e.target as HTMLInputElement).value)}
                min="0"
                step={discountType === "PERCENTAGE" ? "1" : "0.01"}
              />
            )}

            {/* Discount Label */}
            <s-text-field
              label="Discount label (optional)"
              value={discountLabel}
              onInput={(e: Event) => setDiscountLabel((e.target as HTMLInputElement).value)}
              placeholder="e.g., Save 20%"
            />

            {/* Checkboxes */}
            <s-stack direction="block" gap="tight">
              <s-checkbox
                label="Pre-selected by default"
                checked={isDefaultSelected}
                disabled={discountType === "FREE_GIFT" || undefined}
                onChange={(e: Event) => setIsDefaultSelected((e.target as HTMLInputElement).checked)}
              />
              <s-checkbox
                label="Subscription orders only"
                checked={subscriptionOnly}
                onChange={(e: Event) => setSubscriptionOnly((e.target as HTMLInputElement).checked)}
              />
              <s-checkbox
                label="Show quantity selector"
                checked={showQuantitySelector}
                onChange={(e: Event) => setShowQuantitySelector((e.target as HTMLInputElement).checked)}
              />
            </s-stack>

            {/* Max Quantity */}
            {showQuantitySelector && (
              <s-text-field
                label="Maximum quantity"
                type="number"
                value={maxQuantity.toString()}
                onInput={(e: Event) => setMaxQuantity(parseInt((e.target as HTMLInputElement).value) || 1)}
                min="1"
                max="99"
              />
            )}
          </s-stack>
        </div>

        <div style={modalFooterStyle}>
          <s-button variant="secondary" onClick={onClose}>
            Cancel
          </s-button>
          <s-button variant="primary" onClick={handleSave}>
            Save
          </s-button>
        </div>
      </div>
    </div>
  );
}

// Delete Add-On Confirmation Modal Component
interface DeleteAddOnConfirmModalProps {
  productTitle: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function DeleteAddOnConfirmModal({ productTitle, onConfirm, onCancel }: DeleteAddOnConfirmModalProps) {
  const modalOverlayStyle: React.CSSProperties = {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1001,
  };

  const modalContentStyle: React.CSSProperties = {
    backgroundColor: "#fff",
    borderRadius: "16px",
    width: "90%",
    maxWidth: "420px",
    overflow: "hidden",
    boxShadow: "0 20px 60px rgba(0, 0, 0, 0.3)",
  };

  const iconContainerStyle: React.CSSProperties = {
    backgroundColor: "#fef2f2",
    padding: "24px",
    display: "flex",
    justifyContent: "center",
  };

  const iconCircleStyle: React.CSSProperties = {
    width: "64px",
    height: "64px",
    borderRadius: "50%",
    backgroundColor: "#fee2e2",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };

  const contentStyle: React.CSSProperties = {
    padding: "24px",
    textAlign: "center",
  };

  const buttonContainerStyle: React.CSSProperties = {
    display: "flex",
    gap: "12px",
    padding: "0 24px 24px",
  };

  return (
    <div style={modalOverlayStyle} onClick={onCancel}>
      <div style={modalContentStyle} onClick={(e) => e.stopPropagation()}>
        <div style={iconContainerStyle}>
          <div style={iconCircleStyle}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              <line x1="10" y1="11" x2="10" y2="17"></line>
              <line x1="14" y1="11" x2="14" y2="17"></line>
            </svg>
          </div>
        </div>
        <div style={contentStyle}>
          <h3 style={{ margin: "0 0 8px", fontSize: "18px", fontWeight: "600", color: "#111" }}>
            Remove Add-On Product
          </h3>
          <p style={{ margin: "0 0 12px", fontSize: "14px", color: "#6b7280", lineHeight: "1.5" }}>
            Are you sure you want to remove this add-on product? This action cannot be undone.
          </p>
          <p style={{ margin: "0", fontSize: "15px", fontWeight: "500", color: "#374151", backgroundColor: "#f3f4f6", padding: "8px 12px", borderRadius: "6px", display: "inline-block" }}>
            {productTitle || "Untitled product"}
          </p>
        </div>
        <div style={buttonContainerStyle}>
          <button
            onClick={onCancel}
            style={{
              flex: 1,
              padding: "12px 20px",
              fontSize: "14px",
              fontWeight: "500",
              border: "1px solid #d1d5db",
              borderRadius: "8px",
              backgroundColor: "#fff",
              color: "#374151",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              flex: 1,
              padding: "12px 20px",
              fontSize: "14px",
              fontWeight: "500",
              border: "none",
              borderRadius: "8px",
              backgroundColor: "#dc2626",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}

// Delete Targeted Item Confirmation Modal
interface DeleteTargetedItemModalProps {
  item: LocalTargetedItem;
  onConfirm: () => void;
  onCancel: () => void;
}

function DeleteTargetedItemModal({ item, onConfirm, onCancel }: DeleteTargetedItemModalProps) {
  const modalOverlayStyle: React.CSSProperties = {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1001,
  };

  const modalContentStyle: React.CSSProperties = {
    backgroundColor: "#fff",
    borderRadius: "16px",
    width: "90%",
    maxWidth: "420px",
    overflow: "hidden",
    boxShadow: "0 20px 60px rgba(0, 0, 0, 0.3)",
  };

  const iconContainerStyle: React.CSSProperties = {
    backgroundColor: "#fef2f2",
    padding: "24px",
    display: "flex",
    justifyContent: "center",
  };

  const iconCircleStyle: React.CSSProperties = {
    width: "64px",
    height: "64px",
    borderRadius: "50%",
    backgroundColor: "#fee2e2",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };

  const contentStyle: React.CSSProperties = {
    padding: "24px",
    textAlign: "center",
  };

  const buttonContainerStyle: React.CSSProperties = {
    display: "flex",
    gap: "12px",
    padding: "0 24px 24px",
  };

  return (
    <div style={modalOverlayStyle} onClick={onCancel}>
      <div style={modalContentStyle} onClick={(e) => e.stopPropagation()}>
        <div style={iconContainerStyle}>
          <div style={iconCircleStyle}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              <line x1="10" y1="11" x2="10" y2="17"></line>
              <line x1="14" y1="11" x2="14" y2="17"></line>
            </svg>
          </div>
        </div>
        <div style={contentStyle}>
          <h3 style={{ margin: "0 0 8px", fontSize: "18px", fontWeight: "600", color: "#111" }}>
            Remove {item.shopifyResourceType}
          </h3>
          <p style={{ margin: "0 0 12px", fontSize: "14px", color: "#6b7280", lineHeight: "1.5" }}>
            Are you sure you want to remove this {item.shopifyResourceType.toLowerCase()} from targeting?
          </p>
          <p style={{ margin: "0", fontSize: "15px", fontWeight: "500", color: "#374151", backgroundColor: "#f3f4f6", padding: "8px 12px", borderRadius: "6px", display: "inline-block" }}>
            {item.title || item.shopifyResourceId}
          </p>
        </div>
        <div style={buttonContainerStyle}>
          <button
            onClick={onCancel}
            style={{
              flex: 1,
              padding: "12px 20px",
              fontSize: "14px",
              fontWeight: "500",
              border: "1px solid #d1d5db",
              borderRadius: "8px",
              backgroundColor: "#fff",
              color: "#374151",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              flex: 1,
              padding: "12px 20px",
              fontSize: "14px",
              fontWeight: "500",
              border: "none",
              borderRadius: "8px",
              backgroundColor: "#dc2626",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}

// Delete Bundle Confirmation Modal
interface DeleteBundleModalProps {
  bundleTitle: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function DeleteBundleModal({ bundleTitle, onConfirm, onCancel }: DeleteBundleModalProps) {
  const modalOverlayStyle: React.CSSProperties = {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1001,
  };

  const modalContentStyle: React.CSSProperties = {
    backgroundColor: "#fff",
    borderRadius: "16px",
    width: "90%",
    maxWidth: "420px",
    overflow: "hidden",
    boxShadow: "0 20px 60px rgba(0, 0, 0, 0.3)",
  };

  const iconContainerStyle: React.CSSProperties = {
    backgroundColor: "#fef2f2",
    padding: "24px",
    display: "flex",
    justifyContent: "center",
  };

  const iconCircleStyle: React.CSSProperties = {
    width: "64px",
    height: "64px",
    borderRadius: "50%",
    backgroundColor: "#fee2e2",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };

  const contentStyle: React.CSSProperties = {
    padding: "24px",
    textAlign: "center",
  };

  const buttonContainerStyle: React.CSSProperties = {
    display: "flex",
    gap: "12px",
    padding: "0 24px 24px",
  };

  return (
    <div style={modalOverlayStyle} onClick={onCancel}>
      <div style={modalContentStyle} onClick={(e) => e.stopPropagation()}>
        <div style={iconContainerStyle}>
          <div style={iconCircleStyle}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              <line x1="10" y1="11" x2="10" y2="17"></line>
              <line x1="14" y1="11" x2="14" y2="17"></line>
            </svg>
          </div>
        </div>
        <div style={contentStyle}>
          <h3 style={{ margin: "0 0 8px", fontSize: "18px", fontWeight: "600", color: "#111" }}>
            Delete Bundle
          </h3>
          <p style={{ margin: "0 0 12px", fontSize: "14px", color: "#6b7280", lineHeight: "1.5" }}>
            Are you sure you want to delete this bundle? This action cannot be undone.
          </p>
          <p style={{ margin: "0", fontSize: "15px", fontWeight: "500", color: "#374151", backgroundColor: "#f3f4f6", padding: "8px 12px", borderRadius: "6px", display: "inline-block" }}>
            {bundleTitle}
          </p>
        </div>
        <div style={buttonContainerStyle}>
          <button
            onClick={onCancel}
            style={{
              flex: 1,
              padding: "12px 20px",
              fontSize: "14px",
              fontWeight: "500",
              border: "1px solid #d1d5db",
              borderRadius: "8px",
              backgroundColor: "#fff",
              color: "#374151",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              flex: 1,
              padding: "12px 20px",
              fontSize: "14px",
              fontWeight: "500",
              border: "none",
              borderRadius: "8px",
              backgroundColor: "#dc2626",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

export const headers = (headersArgs: Parameters<typeof boundary.headers>[0]) => {
  return boundary.headers(headersArgs);
};
