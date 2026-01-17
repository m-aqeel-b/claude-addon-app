import { useEffect, useState, useRef, useCallback } from "react";
import { useLoaderData, useFetcher, useNavigate, useParams, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getBundle, updateBundle, deleteBundle, bundleTitleExists } from "../models/bundle.server";
import type { BundleWithRelations, ProductGroupWithItems } from "../models/bundle.server";
import { getAddOnSets, createAddOnSet, updateAddOnSet, deleteAddOnSet, setVariantsForSet } from "../models/addOnSet.server";
import type { AddOnSetWithVariants } from "../models/addOnSet.server";
import { updateWidgetStyle, resetWidgetStyle, getOrCreateWidgetStyle, getWidgetStyle } from "../models/widgetStyle.server";
import {
  getTargetedItems,
  addTargetedItem,
  removeTargetedItem,
  getProductGroups,
  createProductGroup,
  updateProductGroup,
  deleteProductGroup,
  addProductGroupItem,
  removeProductGroupItem,
} from "../models/targeting.server";
import {
  buildWidgetConfig,
  syncShopMetafields,
  syncProductMetafields,
  clearShopMetafield,
  clearProductMetafields,
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
} from "@prisma/client";

type TabType = "general" | "addons" | "styles";

interface LoaderData {
  bundle: BundleWithRelations;
  addOnSets: AddOnSetWithVariants[];
  widgetStyle: WidgetStyle;
  targetedItems: BundleTargetedItem[];
  productGroups: ProductGroupWithItems[];
}

// Admin GraphQL client type
type AdminClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<{
    json: () => Promise<{ data?: Record<string, unknown>; errors?: Array<{ message: string }> }>;
  }>;
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

    const widgetConfig = buildWidgetConfig(bundle, addOnSets, widgetStyle);
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

  const [addOnSetsRaw, widgetStyle, targetedItems, productGroups] = await Promise.all([
    getAddOnSets(bundleId),
    getOrCreateWidgetStyle(bundleId),
    getTargetedItems(bundleId),
    getProductGroups(bundleId),
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

  return { bundle, addOnSets, widgetStyle, targetedItems, productGroups };
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

      // Clear product metafields if this was a SPECIFIC_PRODUCTS or PRODUCT_GROUPS bundle
      if (bundleToDelete.targetingType === "SPECIFIC_PRODUCTS" || bundleToDelete.targetingType === "PRODUCT_GROUPS") {
        console.log("[deleteBundle] Clearing product metafields for", bundleToDelete.targetingType, "bundle");
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
            featuredImage {
              url
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
        featuredImage?: { url?: string };
        variants?: { nodes?: Array<{ id: string; title: string; sku?: string; price?: string }> };
      } | undefined;

      productImageUrl = productData?.featuredImage?.url;

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

  // Product group operations (PRODUCT_GROUPS targeting)
  if (intent === "createProductGroup") {
    const title = formData.get("groupTitle") as string;
    await createProductGroup({ bundleId, title });
    return { success: true, action: "productGroupCreated" };
  }

  if (intent === "updateProductGroup") {
    const groupId = formData.get("groupId") as string;
    const title = formData.get("groupTitle") as string;
    await updateProductGroup(groupId, { title });
    return { success: true, action: "productGroupUpdated" };
  }

  if (intent === "deleteProductGroup") {
    const groupId = formData.get("groupId") as string;
    await deleteProductGroup(groupId);
    return { success: true, action: "productGroupDeleted" };
  }

  if (intent === "addProductGroupItem") {
    const groupId = formData.get("groupId") as string;
    const shopifyResourceId = formData.get("shopifyResourceId") as string;
    const shopifyResourceType = formData.get("shopifyResourceType") as "Product" | "Collection";
    const title = formData.get("resourceTitle") as string;
    const imageUrl = formData.get("imageUrl") as string;

    await addProductGroupItem({
      productGroupId: groupId,
      shopifyResourceId,
      shopifyResourceType,
      title,
      imageUrl: imageUrl || undefined,
    });

    return { success: true, action: "productGroupItemAdded" };
  }

  if (intent === "removeProductGroupItem") {
    const itemId = formData.get("itemId") as string;
    await removeProductGroupItem(itemId);
    return { success: true, action: "productGroupItemRemoved" };
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

export default function EditBundle() {
  const { bundle, addOnSets, widgetStyle, targetedItems, productGroups } = useLoaderData<LoaderData>();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [newGroupTitle, setNewGroupTitle] = useState("");

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

  const [activeTab, setActiveTab] = useState<TabType>("general");

  // Refs for web component buttons
  const saveButtonRef = useRef<HTMLElement>(null);
  const deleteButtonRef = useRef<HTMLElement>(null);
  const syncButtonRef = useRef<HTMLElement>(null);
  const generalTabRef = useRef<HTMLElement>(null);
  const addonsTabRef = useRef<HTMLElement>(null);
  const stylesTabRef = useRef<HTMLElement>(null);
  const addProductButtonRef = useRef<HTMLElement>(null);
  const resetStylesButtonRef = useRef<HTMLElement>(null);
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
  });

  const [style, setStyle] = useState({
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
    } else if (fetcher.data?.action === "bundleDeleted") {
      shopify.toast.show("Bundle deleted");
      navigate("/app/bundles");
    } else if (fetcher.data?.action === "addOnCreated") {
      shopify.toast.show("Add-on added & synced to store");
    } else if (fetcher.data?.action === "addOnUpdated") {
      shopify.toast.show("Add-on saved & synced to store");
    } else if (fetcher.data?.action === "addOnDeleted") {
      shopify.toast.show("Add-on removed & synced to store");
    } else if (fetcher.data?.action === "styleUpdated") {
      shopify.toast.show("Styles saved & synced to store");
    } else if (fetcher.data?.action === "styleReset") {
      shopify.toast.show("Styles reset & synced to store");
    } else if (fetcher.data?.action === "targetedItemAdded") {
      shopify.toast.show("Product/collection added & synced");
    } else if (fetcher.data?.action === "targetedItemRemoved") {
      shopify.toast.show("Product/collection removed & synced");
    } else if (fetcher.data?.action === "productGroupCreated") {
      shopify.toast.show("Group created");
      setNewGroupTitle("");
    } else if (fetcher.data?.action === "productGroupUpdated") {
      shopify.toast.show("Group updated");
    } else if (fetcher.data?.action === "productGroupDeleted") {
      shopify.toast.show("Group deleted");
    } else if (fetcher.data?.action === "productGroupItemAdded") {
      shopify.toast.show("Product added to group");
    } else if (fetcher.data?.action === "productGroupItemRemoved") {
      shopify.toast.show("Product removed from group");
    } else if (fetcher.data?.action === "metafieldsSynced") {
      shopify.toast.show("Force synced to store");
    } else if (fetcher.data?.action === "variantsUpdated") {
      shopify.toast.show("Variants updated & synced to store");
    }
  }, [fetcher.data, shopify, navigate]);

  const handleFormChange = (field: string, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleStyleChange = (field: string, value: string | number) => {
    setStyle((prev) => ({ ...prev, [field]: value }));
  };

  const handleSaveBundle = useCallback(() => {
    fetcher.submit({ intent: "updateBundle", ...form }, { method: "POST" });
  }, [fetcher, form]);

  const handleDeleteBundle = useCallback(() => {
    if (confirm(`Are you sure you want to delete "${bundle.title}"? This cannot be undone.`)) {
      fetcher.submit({ intent: "deleteBundle" }, { method: "POST" });
    }
  }, [fetcher, bundle.title]);

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
    if (confirm("Reset all styles to defaults?")) {
      fetcher.submit({ intent: "resetStyle" }, { method: "POST" });
    }
  }, [fetcher]);

  const handleDeleteAddOn = (addOnSetId: string, title: string) => {
    if (confirm(`Remove "${title}" from this bundle?`)) {
      fetcher.submit({ intent: "deleteAddOnSet", addOnSetId }, { method: "POST" });
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

      // Get the selected variants from the picker (if any)
      const selectedVariants = product.variants || [];

      fetcher.submit(
        {
          intent: "createAddOnSet",
          shopifyProductId: product.id,
          productTitle: product.title,
          // Pass selected variants from the picker
          selectedVariants: JSON.stringify(selectedVariants.map(v => ({
            shopifyVariantId: v.id,
            variantTitle: v.title,
            variantSku: v.sku || null,
            variantPrice: v.price ? parseFloat(v.price) : null,
          }))),
        },
        { method: "POST" }
      );
    }
  }, [shopify, fetcher]);

  // Edit variants for an existing add-on
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
        variants?: Array<{
          id: string;
          title: string;
          sku?: string;
          price?: string;
        }>;
      };

      const selectedVariants = product.variants || [];

      if (selectedVariants.length > 0) {
        fetcher.submit(
          {
            intent: "updateAddOnSetVariants",
            addOnSetId,
            selectedVariants: JSON.stringify(selectedVariants.map(v => ({
              shopifyVariantId: v.id,
              variantTitle: v.title,
              variantSku: v.sku || null,
              variantPrice: v.price ? parseFloat(v.price) : null,
            }))),
          },
          { method: "POST" }
        );
      }
    }
  }, [shopify, fetcher]);

  // Attach event listeners for web component buttons
  useEffect(() => {
    const saveBtn = saveButtonRef.current;
    const handler = activeTab === "styles" ? handleSaveStyles : handleSaveBundle;
    if (saveBtn) {
      saveBtn.addEventListener("click", handler);
      return () => saveBtn.removeEventListener("click", handler);
    }
  }, [activeTab, handleSaveStyles, handleSaveBundle]);

  useEffect(() => {
    const deleteBtn = deleteButtonRef.current;
    if (deleteBtn) {
      deleteBtn.addEventListener("click", handleDeleteBundle);
      return () => deleteBtn.removeEventListener("click", handleDeleteBundle);
    }
  }, [handleDeleteBundle]);

  useEffect(() => {
    const syncBtn = syncButtonRef.current;
    if (syncBtn) {
      syncBtn.addEventListener("click", handleSyncMetafields);
      return () => syncBtn.removeEventListener("click", handleSyncMetafields);
    }
  }, [handleSyncMetafields]);

  useEffect(() => {
    const btn = generalTabRef.current;
    const handler = () => setActiveTab("general");
    if (btn) {
      btn.addEventListener("click", handler);
      return () => btn.removeEventListener("click", handler);
    }
  }, []);

  useEffect(() => {
    const btn = addonsTabRef.current;
    const handler = () => setActiveTab("addons");
    if (btn) {
      btn.addEventListener("click", handler);
      return () => btn.removeEventListener("click", handler);
    }
  }, []);

  useEffect(() => {
    const btn = stylesTabRef.current;
    const handler = () => setActiveTab("styles");
    if (btn) {
      btn.addEventListener("click", handler);
      return () => btn.removeEventListener("click", handler);
    }
  }, []);

  useEffect(() => {
    const btn = addProductButtonRef.current;
    if (btn) {
      btn.addEventListener("click", openProductPicker);
      return () => btn.removeEventListener("click", openProductPicker);
    }
  }, [openProductPicker, activeTab]);

  useEffect(() => {
    const btn = resetStylesButtonRef.current;
    if (btn) {
      btn.addEventListener("click", handleResetStyles);
      return () => btn.removeEventListener("click", handleResetStyles);
    }
  }, [handleResetStyles, activeTab]);

  // Targeting handlers
  const openTargetedResourcePicker = async (type: "product" | "collection") => {
    const selected = await shopify.resourcePicker({ type, multiple: true });
    if (selected && selected.length > 0) {
      for (const resource of selected) {
        fetcher.submit(
          {
            intent: "addTargetedItem",
            shopifyResourceId: resource.id,
            shopifyResourceType: type === "product" ? "Product" : "Collection",
            resourceTitle: resource.title,
            imageUrl: (resource as { images?: { originalSrc?: string }[] }).images?.[0]?.originalSrc || "",
          },
          { method: "POST" }
        );
      }
    }
  };

  const handleRemoveTargetedItem = (itemId: string) => {
    fetcher.submit({ intent: "removeTargetedItem", itemId }, { method: "POST" });
  };

  const handleCreateProductGroup = () => {
    if (newGroupTitle.trim()) {
      fetcher.submit({ intent: "createProductGroup", groupTitle: newGroupTitle.trim() }, { method: "POST" });
    }
  };

  const handleDeleteProductGroup = (groupId: string, title: string) => {
    if (confirm(`Delete group "${title}"? All products in this group will be removed.`)) {
      fetcher.submit({ intent: "deleteProductGroup", groupId }, { method: "POST" });
    }
  };

  const openGroupResourcePicker = async (groupId: string) => {
    const selected = await shopify.resourcePicker({ type: "product", multiple: true });
    if (selected && selected.length > 0) {
      for (const resource of selected) {
        fetcher.submit(
          {
            intent: "addProductGroupItem",
            groupId,
            shopifyResourceId: resource.id,
            shopifyResourceType: "Product",
            resourceTitle: resource.title,
            imageUrl: (resource as { images?: { originalSrc?: string }[] }).images?.[0]?.originalSrc || "",
          },
          { method: "POST" }
        );
      }
    }
  };

  const handleRemoveProductGroupItem = (itemId: string) => {
    fetcher.submit({ intent: "removeProductGroupItem", itemId }, { method: "POST" });
  };

  return (
    <s-page
      heading={bundle.title}
      back-action="/app/bundles"
    >
      <s-button
        ref={saveButtonRef}
        slot="primary-action"
        variant="primary"
        {...(isSubmitting ? { loading: true } : {})}
      >
        Save
      </s-button>
      <s-button
        ref={deleteButtonRef}
        slot="secondary-action"
        variant="tertiary"
        tone="critical"
      >
        Delete
      </s-button>

      {/* Force Sync Button - for debugging, normally not needed */}
      <s-button
        ref={syncButtonRef}
        slot="secondary-action"
        variant="tertiary"
        title="Force sync to store (normally not needed - saves auto-sync)"
      >
        Force Sync
      </s-button>

      {/* Tab Navigation */}
      <s-section>
        <s-stack direction="inline" gap="tight">
          <s-button
            ref={generalTabRef}
            variant={activeTab === "general" ? "primary" : "secondary"}
          >
            General
          </s-button>
          <s-button
            ref={addonsTabRef}
            variant={activeTab === "addons" ? "primary" : "secondary"}
          >
            Add-ons ({addOnSets.length})
          </s-button>
          <s-button
            ref={stylesTabRef}
            variant={activeTab === "styles" ? "primary" : "secondary"}
          >
            Styles
          </s-button>
        </s-stack>
      </s-section>

      {/* General Tab */}
      {activeTab === "general" && (
        <>
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

          <s-section heading="Status & Schedule">
            <s-stack direction="block" gap="base">
              <div>
                <label style={{ display: "block", marginBottom: "4px", fontWeight: 500, fontSize: "14px" }}>Status</label>
                <select
                  style={{ width: "100%", padding: "8px 12px", borderRadius: "8px", border: "1px solid #8c9196", fontSize: "14px", backgroundColor: "#fff" }}
                  value={form.status}
                  onChange={(e) => handleFormChange("status", e.target.value)}
                >
                  <option value="DRAFT">Draft</option>
                  <option value="ACTIVE">Active</option>
                  <option value="ARCHIVED">Archived</option>
                </select>
              </div>

              <s-stack direction="inline" gap="base">
                <div style={{ flex: 1 }}>
                  <label style={{ display: "block", marginBottom: "4px", fontWeight: 500, fontSize: "14px" }}>Start date</label>
                  <input
                    type="datetime-local"
                    style={{ width: "100%", padding: "8px 12px", borderRadius: "8px", border: "1px solid #8c9196", fontSize: "14px", backgroundColor: "#fff" }}
                    value={form.startDate}
                    onChange={(e) => handleFormChange("startDate", e.target.value)}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ display: "block", marginBottom: "4px", fontWeight: 500, fontSize: "14px" }}>End date</label>
                  <input
                    type="datetime-local"
                    style={{ width: "100%", padding: "8px 12px", borderRadius: "8px", border: errors.endDate ? "1px solid #d72c0d" : "1px solid #8c9196", fontSize: "14px", backgroundColor: "#fff" }}
                    value={form.endDate}
                    onChange={(e) => handleFormChange("endDate", e.target.value)}
                  />
                  {errors.endDate && (
                    <span style={{ color: "#d72c0d", fontSize: "12px", marginTop: "4px", display: "block" }}>{errors.endDate}</span>
                  )}
                </div>
              </s-stack>
            </s-stack>
          </s-section>

          <s-section heading="Selection mode">
            <div>
              <label style={{ display: "block", marginBottom: "8px", fontWeight: 500, fontSize: "14px" }}>How can customers select add-ons?</label>
              <s-stack direction="block" gap="tight">
                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="selectionMode"
                    value="MULTIPLE"
                    checked={form.selectionMode === "MULTIPLE"}
                    onChange={(e) => handleFormChange("selectionMode", e.target.value)}
                  />
                  <span>Multiple selection (checkboxes)</span>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="selectionMode"
                    value="SINGLE"
                    checked={form.selectionMode === "SINGLE"}
                    onChange={(e) => handleFormChange("selectionMode", e.target.value)}
                  />
                  <span>Single selection (radio buttons)</span>
                </label>
              </s-stack>
            </div>
          </s-section>

          <s-section heading="Product targeting">
            <s-stack direction="block" gap="base">
              <div>
                <label style={{ display: "block", marginBottom: "8px", fontWeight: 500, fontSize: "14px" }}>Which products show this bundle?</label>
                <s-stack direction="block" gap="tight">
                  <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                    <input
                      type="radio"
                      name="targetingType"
                      value="ALL_PRODUCTS"
                      checked={form.targetingType === "ALL_PRODUCTS"}
                      onChange={(e) => handleFormChange("targetingType", e.target.value)}
                    />
                    <span>All products</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                    <input
                      type="radio"
                      name="targetingType"
                      value="SPECIFIC_PRODUCTS"
                      checked={form.targetingType === "SPECIFIC_PRODUCTS"}
                      onChange={(e) => handleFormChange("targetingType", e.target.value)}
                    />
                    <span>Specific products or collections</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                    <input
                      type="radio"
                      name="targetingType"
                      value="PRODUCT_GROUPS"
                      checked={form.targetingType === "PRODUCT_GROUPS"}
                      onChange={(e) => handleFormChange("targetingType", e.target.value)}
                    />
                    <span>Product groups (with tabs)</span>
                  </label>
                </s-stack>
              </div>

              {/* Description for each targeting type */}
              {form.targetingType === "ALL_PRODUCTS" && (
                <s-text color="subdued">
                  Add-ons will appear on all product pages in your store.
                </s-text>
              )}

              {/* Specific products/collections UI */}
              {form.targetingType === "SPECIFIC_PRODUCTS" && (
                <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
                  <s-stack direction="block" gap="base">
                    <s-text variant="headingSm">Selected products and collections</s-text>
                    <s-text color="subdued">
                      Add-ons will only appear on these specific products or products in these collections.
                    </s-text>

                    <s-stack direction="inline" gap="tight">
                      <button
                        style={{ padding: "8px 16px", borderRadius: "8px", border: "1px solid #8c9196", backgroundColor: "#fff", cursor: "pointer", fontSize: "14px" }}
                        onClick={() => openTargetedResourcePicker("product")}
                      >
                        Add products
                      </button>
                      <button
                        style={{ padding: "8px 16px", borderRadius: "8px", border: "1px solid #8c9196", backgroundColor: "#fff", cursor: "pointer", fontSize: "14px" }}
                        onClick={() => openTargetedResourcePicker("collection")}
                      >
                        Add collections
                      </button>
                    </s-stack>

                    {targetedItems.length === 0 ? (
                      <s-text color="subdued" variant="bodySm">
                        No products or collections selected yet.
                      </s-text>
                    ) : (
                      <s-stack direction="block" gap="tight">
                        {targetedItems.map((item) => (
                          <s-box key={item.id} padding="tight" borderWidth="base" borderRadius="base">
                            <s-stack direction="inline" gap="tight">
                              <s-badge tone={item.shopifyResourceType === "Product" ? "info" : "success"}>
                                {item.shopifyResourceType}
                              </s-badge>
                              <s-text style={{ flex: 1 }}>{item.title || item.shopifyResourceId}</s-text>
                              <button
                                style={{ background: "none", border: "none", color: "#d72c0d", cursor: "pointer", fontSize: "14px" }}
                                onClick={() => handleRemoveTargetedItem(item.id)}
                              >
                                Remove
                              </button>
                            </s-stack>
                          </s-box>
                        ))}
                      </s-stack>
                    )}
                  </s-stack>
                </s-box>
              )}

              {/* Product groups UI */}
              {form.targetingType === "PRODUCT_GROUPS" && (
                <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
                  <s-stack direction="block" gap="base">
                    <s-text variant="headingSm">Product groups</s-text>
                    <s-text color="subdued">
                      Create groups of products. Each group will appear as a tab in the widget.
                    </s-text>

                    {/* Create new group */}
                    <s-stack direction="inline" gap="tight">
                      <div style={{ flex: 1 }}>
                        <label style={{ display: "block", marginBottom: "4px", fontWeight: 500, fontSize: "14px" }}>New group name</label>
                        <input
                          type="text"
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "8px", border: "1px solid #8c9196", fontSize: "14px", backgroundColor: "#fff" }}
                          value={newGroupTitle}
                          onChange={(e) => setNewGroupTitle(e.target.value)}
                          placeholder="e.g., Accessories"
                        />
                      </div>
                      <button
                        style={{ padding: "8px 16px", borderRadius: "8px", border: "1px solid #8c9196", backgroundColor: "#fff", cursor: "pointer", fontSize: "14px", alignSelf: "flex-end" }}
                        onClick={handleCreateProductGroup}
                        disabled={!newGroupTitle.trim()}
                      >
                        Create group
                      </button>
                    </s-stack>

                    {/* Existing groups */}
                    {productGroups.length === 0 ? (
                      <s-text color="subdued" variant="bodySm">
                        No product groups created yet.
                      </s-text>
                    ) : (
                      <s-stack direction="block" gap="base">
                        {productGroups.map((group) => (
                          <s-box key={group.id} padding="base" borderWidth="base" borderRadius="base">
                            <s-stack direction="block" gap="tight">
                              <s-stack direction="inline" gap="tight">
                                <s-text variant="headingSm" style={{ flex: 1 }}>{group.title}</s-text>
                                <button
                                  style={{ background: "none", border: "none", color: "#2c6ecb", cursor: "pointer", fontSize: "14px" }}
                                  onClick={() => openGroupResourcePicker(group.id)}
                                >
                                  Add products
                                </button>
                                <button
                                  style={{ background: "none", border: "none", color: "#d72c0d", cursor: "pointer", fontSize: "14px" }}
                                  onClick={() => handleDeleteProductGroup(group.id, group.title)}
                                >
                                  Delete group
                                </button>
                              </s-stack>

                              {group.items.length === 0 ? (
                                <s-text color="subdued" variant="bodySm">
                                  No products in this group.
                                </s-text>
                              ) : (
                                <s-stack direction="inline" gap="tight" wrap>
                                  {group.items.map((item) => (
                                    <s-box key={item.id} padding="tight" borderWidth="base" borderRadius="base">
                                      <s-stack direction="inline" gap="tight">
                                        <s-text variant="bodySm">{item.title || "Product"}</s-text>
                                        <button
                                          style={{ background: "none", border: "none", color: "#d72c0d", cursor: "pointer", fontSize: "14px" }}
                                          onClick={() => handleRemoveProductGroupItem(item.id)}
                                        >
                                          ×
                                        </button>
                                      </s-stack>
                                    </s-box>
                                  ))}
                                </s-stack>
                              )}
                            </s-stack>
                          </s-box>
                        ))}
                      </s-stack>
                    )}
                  </s-stack>
                </s-box>
              )}
            </s-stack>
          </s-section>

          <s-section heading="Discount combinations">
            <s-stack direction="block" gap="base">
              <div>
                <label style={{ display: "block", marginBottom: "4px", fontWeight: 500, fontSize: "14px" }}>With product discounts</label>
                <select
                  style={{ width: "100%", padding: "8px 12px", borderRadius: "8px", border: "1px solid #8c9196", fontSize: "14px", backgroundColor: "#fff" }}
                  value={form.combineWithProductDiscounts}
                  onChange={(e) => handleFormChange("combineWithProductDiscounts", e.target.value)}
                >
                  <option value="COMBINE">Combine</option>
                  <option value="NOT_COMBINE">Do not combine</option>
                </select>
              </div>
              <div>
                <label style={{ display: "block", marginBottom: "4px", fontWeight: 500, fontSize: "14px" }}>With order discounts</label>
                <select
                  style={{ width: "100%", padding: "8px 12px", borderRadius: "8px", border: "1px solid #8c9196", fontSize: "14px", backgroundColor: "#fff" }}
                  value={form.combineWithOrderDiscounts}
                  onChange={(e) => handleFormChange("combineWithOrderDiscounts", e.target.value)}
                >
                  <option value="COMBINE">Combine</option>
                  <option value="NOT_COMBINE">Do not combine</option>
                </select>
              </div>
              <div>
                <label style={{ display: "block", marginBottom: "4px", fontWeight: 500, fontSize: "14px" }}>With shipping discounts</label>
                <select
                  style={{ width: "100%", padding: "8px 12px", borderRadius: "8px", border: "1px solid #8c9196", fontSize: "14px", backgroundColor: "#fff" }}
                  value={form.combineWithShippingDiscounts}
                  onChange={(e) => handleFormChange("combineWithShippingDiscounts", e.target.value)}
                >
                  <option value="COMBINE">Combine</option>
                  <option value="NOT_COMBINE">Do not combine</option>
                </select>
              </div>
            </s-stack>
          </s-section>
        </>
      )}

      {/* Add-ons Tab */}
      {activeTab === "addons" && (
        <>
          <s-section heading="Add-on products">
            <s-stack direction="block" gap="base">
              <s-button ref={addProductButtonRef} variant="secondary">
                Add product
              </s-button>

              {addOnSets.length === 0 ? (
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
                  {addOnSets.map((addOn) => (
                    <AddOnSetCard
                      key={addOn.id}
                      addOn={addOn}
                      onDelete={() => handleDeleteAddOn(addOn.id, addOn.productTitle || "Add-on")}
                      onUpdate={(data) => {
                        fetcher.submit(
                          { intent: "updateAddOnSet", addOnSetId: addOn.id, ...data },
                          { method: "POST" }
                        );
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
        </>
      )}

      {/* Styles Tab */}
      {activeTab === "styles" && (
        <>
          <s-section heading="Colors">
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="base">
                <s-text-field
                  type="color"
                  label="Background"
                  value={style.backgroundColor}
                  onInput={(e: Event) => handleStyleChange("backgroundColor", (e.target as HTMLInputElement).value)}
                />
                <s-text-field
                  type="color"
                  label="Font"
                  value={style.fontColor}
                  onInput={(e: Event) => handleStyleChange("fontColor", (e.target as HTMLInputElement).value)}
                />
              </s-stack>
              <s-stack direction="inline" gap="base">
                <s-text-field
                  type="color"
                  label="Button"
                  value={style.buttonColor}
                  onInput={(e: Event) => handleStyleChange("buttonColor", (e.target as HTMLInputElement).value)}
                />
                <s-text-field
                  type="color"
                  label="Button text"
                  value={style.buttonTextColor}
                  onInput={(e: Event) => handleStyleChange("buttonTextColor", (e.target as HTMLInputElement).value)}
                />
              </s-stack>
              <s-stack direction="inline" gap="base">
                <s-text-field
                  type="color"
                  label="Discount badge"
                  value={style.discountBadgeColor}
                  onInput={(e: Event) => handleStyleChange("discountBadgeColor", (e.target as HTMLInputElement).value)}
                />
                <s-text-field
                  type="color"
                  label="Discount text"
                  value={style.discountTextColor}
                  onInput={(e: Event) => handleStyleChange("discountTextColor", (e.target as HTMLInputElement).value)}
                />
              </s-stack>
              <s-text-field
                type="color"
                label="Border color"
                value={style.borderColor}
                onInput={(e: Event) => handleStyleChange("borderColor", (e.target as HTMLInputElement).value)}
              />
            </s-stack>
          </s-section>

          <s-section heading="Layout">
            <s-stack direction="block" gap="base">
              <div>
                <label style={{ display: "block", marginBottom: "4px", fontWeight: 500, fontSize: "14px" }}>Layout type</label>
                <select
                  style={{ width: "100%", padding: "8px 12px", borderRadius: "8px", border: "1px solid #8c9196", fontSize: "14px", backgroundColor: "#fff" }}
                  value={style.layoutType}
                  onChange={(e) => handleStyleChange("layoutType", e.target.value)}
                >
                  <option value="LIST">List</option>
                  <option value="GRID">Grid</option>
                </select>
              </div>
              <div>
                <label style={{ display: "block", marginBottom: "4px", fontWeight: 500, fontSize: "14px" }}>Image size</label>
                <select
                  style={{ width: "100%", padding: "8px 12px", borderRadius: "8px", border: "1px solid #8c9196", fontSize: "14px", backgroundColor: "#fff" }}
                  value={style.imageSize}
                  onChange={(e) => handleStyleChange("imageSize", e.target.value)}
                >
                  <option value="SMALL">Small</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="LARGE">Large</option>
                </select>
              </div>
              <div>
                <label style={{ display: "block", marginBottom: "4px", fontWeight: 500, fontSize: "14px" }}>Discount label style</label>
                <select
                  style={{ width: "100%", padding: "8px 12px", borderRadius: "8px", border: "1px solid #8c9196", fontSize: "14px", backgroundColor: "#fff" }}
                  value={style.discountLabelStyle}
                  onChange={(e) => handleStyleChange("discountLabelStyle", e.target.value)}
                >
                  <option value="BADGE">Badge</option>
                  <option value="HIGHLIGHTED_TEXT">Highlighted text</option>
                </select>
              </div>
            </s-stack>
          </s-section>

          <s-section heading="Typography">
            <s-stack direction="block" gap="base">
              <s-text-field
                type="number"
                label="Title font size (px)"
                value={String(style.titleFontSize)}
                onInput={(e: Event) => handleStyleChange("titleFontSize", parseInt((e.target as HTMLInputElement).value))}
                min="10"
                max="32"
              />
              <s-text-field
                type="number"
                label="Subtitle font size (px)"
                value={String(style.subtitleFontSize)}
                onInput={(e: Event) => handleStyleChange("subtitleFontSize", parseInt((e.target as HTMLInputElement).value))}
                min="10"
                max="24"
              />
              <s-text-field
                type="number"
                label="Body font size (px)"
                value={String(style.fontSize)}
                onInput={(e: Event) => handleStyleChange("fontSize", parseInt((e.target as HTMLInputElement).value))}
                min="10"
                max="20"
              />
            </s-stack>
          </s-section>

          <s-section heading="Spacing & Borders">
            <s-stack direction="block" gap="base">
              <s-text-field
                type="number"
                label="Border radius (px)"
                value={String(style.borderRadius)}
                onInput={(e: Event) => handleStyleChange("borderRadius", parseInt((e.target as HTMLInputElement).value))}
                min="0"
                max="24"
              />
              <div>
                <label style={{ display: "block", marginBottom: "4px", fontWeight: 500, fontSize: "14px" }}>Border style</label>
                <select
                  style={{ width: "100%", padding: "8px 12px", borderRadius: "8px", border: "1px solid #8c9196", fontSize: "14px", backgroundColor: "#fff" }}
                  value={style.borderStyle}
                  onChange={(e) => handleStyleChange("borderStyle", e.target.value)}
                >
                  <option value="NONE">None</option>
                  <option value="SOLID">Solid</option>
                  <option value="DASHED">Dashed</option>
                  <option value="DOTTED">Dotted</option>
                </select>
              </div>
              <s-text-field
                type="number"
                label="Border width (px)"
                value={String(style.borderWidth)}
                onInput={(e: Event) => handleStyleChange("borderWidth", parseInt((e.target as HTMLInputElement).value))}
                min="0"
                max="5"
              />
              <s-text-field
                type="number"
                label="Padding (px)"
                value={String(style.padding)}
                onInput={(e: Event) => handleStyleChange("padding", parseInt((e.target as HTMLInputElement).value))}
                min="0"
                max="48"
              />
              <s-stack direction="inline" gap="base">
                <s-text-field
                  type="number"
                  label="Margin top (px)"
                  value={String(style.marginTop)}
                  onInput={(e: Event) => handleStyleChange("marginTop", parseInt((e.target as HTMLInputElement).value))}
                  min="0"
                  max="64"
                />
                <s-text-field
                  type="number"
                  label="Margin bottom (px)"
                  value={String(style.marginBottom)}
                  onInput={(e: Event) => handleStyleChange("marginBottom", parseInt((e.target as HTMLInputElement).value))}
                  min="0"
                  max="64"
                />
              </s-stack>
            </s-stack>
          </s-section>

          <s-section>
            <s-button ref={resetStylesButtonRef} variant="tertiary">
              Reset to defaults
            </s-button>
          </s-section>
        </>
      )}

      {/* Live Preview Aside */}
      <s-section slot="aside" heading="Preview">
        <WidgetPreview
          bundle={bundle}
          addOnSets={addOnSets}
          style={style}
        />
      </s-section>
    </s-page>
  );
}

// Add-On Set Card Component
interface AddOnSetCardProps {
  addOn: AddOnSetWithVariants;
  onDelete: () => void;
  onUpdate: (data: Record<string, string>) => void;
  onEditVariants: () => void;
}

function AddOnSetCard({ addOn, onDelete, onUpdate, onEditVariants }: AddOnSetCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
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
  };

  const selectStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 12px",
    borderRadius: "8px",
    border: "1px solid #8c9196",
    fontSize: "14px",
    backgroundColor: "#fff",
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 12px",
    borderRadius: "8px",
    border: "1px solid #8c9196",
    fontSize: "14px",
    backgroundColor: "#fff",
  };

  const labelStyle: React.CSSProperties = {
    display: "block",
    marginBottom: "4px",
    fontWeight: 500,
    fontSize: "14px",
  };

  const checkboxLabelStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    cursor: "pointer",
    fontSize: "14px",
  };

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base">
          <s-stack direction="block" gap="tight" style={{ flex: 1 }}>
            <s-text variant="headingSm">{addOn.productTitle || "Untitled product"}</s-text>
            <s-text variant="bodySm" color="subdued">
              {discountType === "FREE_GIFT" ? "Free gift" : `${discountType.replace(/_/g, " ")}${discountValue ? `: ${discountValue}` : ""}`}
            </s-text>
          </s-stack>
          <button
            style={{ background: "none", border: "none", color: "#2c6ecb", cursor: "pointer", fontSize: "14px" }}
            onClick={() => setIsExpanded(!isExpanded)}
          >
            {isExpanded ? "Collapse" : "Configure"}
          </button>
          <button
            style={{ background: "none", border: "none", color: "#d72c0d", cursor: "pointer", fontSize: "14px" }}
            onClick={onDelete}
          >
            Remove
          </button>
        </s-stack>

        {isExpanded && (
          <s-stack direction="block" gap="base">
            <div>
              <label style={labelStyle}>Discount type</label>
              <select
                style={selectStyle}
                value={discountType}
                onChange={(e) => setDiscountType(e.target.value as DiscountType)}
              >
                <option value="PERCENTAGE">Percentage</option>
                <option value="FIXED_AMOUNT">Fixed amount off</option>
                <option value="FIXED_PRICE">Fixed price</option>
                <option value="FREE_GIFT">Free gift (100% off)</option>
              </select>
            </div>

            {discountType !== "FREE_GIFT" && (
              <div>
                <label style={labelStyle}>
                  {discountType === "PERCENTAGE" ? "Discount percentage" : "Discount amount"}
                </label>
                <input
                  type="number"
                  style={inputStyle}
                  value={discountValue}
                  onChange={(e) => setDiscountValue(e.target.value)}
                  min="0"
                  step={discountType === "PERCENTAGE" ? "1" : "0.01"}
                />
              </div>
            )}

            <div>
              <label style={labelStyle}>Discount label (optional)</label>
              <input
                type="text"
                style={inputStyle}
                value={discountLabel}
                onChange={(e) => setDiscountLabel(e.target.value)}
                placeholder="e.g., Save 20%"
              />
            </div>

            <label style={checkboxLabelStyle}>
              <input
                type="checkbox"
                checked={isDefaultSelected}
                onChange={(e) => setIsDefaultSelected(e.target.checked)}
                disabled={discountType === "FREE_GIFT"}
              />
              <span>Pre-selected by default</span>
            </label>

            <label style={checkboxLabelStyle}>
              <input
                type="checkbox"
                checked={subscriptionOnly}
                onChange={(e) => setSubscriptionOnly(e.target.checked)}
              />
              <span>Subscription orders only</span>
            </label>

            <label style={checkboxLabelStyle}>
              <input
                type="checkbox"
                checked={showQuantitySelector}
                onChange={(e) => setShowQuantitySelector(e.target.checked)}
              />
              <span>Show quantity selector</span>
            </label>

            {showQuantitySelector && (
              <div>
                <label style={labelStyle}>Maximum quantity</label>
                <input
                  type="number"
                  style={inputStyle}
                  value={maxQuantity}
                  onChange={(e) => setMaxQuantity(parseInt(e.target.value) || 1)}
                  min="1"
                  max="99"
                />
              </div>
            )}

            <s-stack direction="inline" gap="tight" align="center">
              <button
                style={{
                  padding: "8px 16px",
                  borderRadius: "8px",
                  border: "1px solid #8c9196",
                  backgroundColor: "#fff",
                  cursor: "pointer",
                  fontSize: "14px",
                }}
                onClick={handleSave}
              >
                Save add-on settings
              </button>
              <s-text variant="bodySm" color="subdued">
                {addOn.selectedVariants.length} variant(s) included
              </s-text>
              <button
                style={{ background: "none", border: "none", color: "#2c6ecb", cursor: "pointer", fontSize: "14px" }}
                onClick={onEditVariants}
              >
                Edit variants
              </button>
            </s-stack>
          </s-stack>
        )}
      </s-stack>
    </s-box>
  );
}

// Widget Preview Component
interface WidgetPreviewProps {
  bundle: BundleWithRelations;
  addOnSets: AddOnSetWithVariants[];
  style: Record<string, string | number>;
}

function WidgetPreview({ bundle, addOnSets, style }: WidgetPreviewProps) {
  const previewStyle: React.CSSProperties = {
    backgroundColor: style.backgroundColor as string,
    color: style.fontColor as string,
    borderRadius: `${style.borderRadius}px`,
    borderStyle: style.borderStyle === "NONE" ? "none" : (style.borderStyle as string).toLowerCase(),
    borderWidth: `${style.borderWidth}px`,
    borderColor: style.borderColor as string,
    padding: `${style.padding}px`,
    marginTop: `${style.marginTop}px`,
    marginBottom: `${style.marginBottom}px`,
    fontSize: `${style.fontSize}px`,
  };

  const titleStyle: React.CSSProperties = {
    fontSize: `${style.titleFontSize}px`,
    fontWeight: "bold",
    marginBottom: "8px",
  };

  const subtitleStyle: React.CSSProperties = {
    fontSize: `${style.subtitleFontSize}px`,
    opacity: 0.8,
    marginBottom: "16px",
  };

  const badgeStyle: React.CSSProperties = {
    backgroundColor: style.discountBadgeColor as string,
    color: style.discountTextColor as string,
    padding: "2px 8px",
    borderRadius: "4px",
    fontSize: "12px",
    marginLeft: "8px",
  };

  return (
    <div style={previewStyle}>
      <div style={titleStyle}>{bundle.title || "Bundle Title"}</div>
      {bundle.subtitle && <div style={subtitleStyle}>{bundle.subtitle}</div>}

      {addOnSets.length === 0 ? (
        <div style={{ opacity: 0.6, textAlign: "center", padding: "20px" }}>
          No add-ons configured
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: style.layoutType === "GRID" ? "row" : "column", gap: "12px", flexWrap: "wrap" }}>
          {addOnSets.slice(0, 3).map((addOn) => (
            <div
              key={addOn.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "8px",
                backgroundColor: "rgba(0,0,0,0.05)",
                borderRadius: "4px",
                flex: style.layoutType === "GRID" ? "1 1 45%" : "none",
              }}
            >
              <input
                type={bundle.selectionMode === "SINGLE" ? "radio" : "checkbox"}
                defaultChecked={addOn.isDefaultSelected}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500 }}>
                  {addOn.productTitle || "Product"}
                  {addOn.discountValue && style.discountLabelStyle === "BADGE" && (
                    <span style={badgeStyle}>
                      {addOn.discountLabel || `${addOn.discountValue}% off`}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
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

export const headers = (headersArgs: Parameters<typeof boundary.headers>[0]) => {
  return boundary.headers(headersArgs);
};
