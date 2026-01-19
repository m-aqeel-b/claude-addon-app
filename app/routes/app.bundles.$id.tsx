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

// Style state type for local management
interface StyleState {
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
}

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
  const [isStyleModalOpen, setIsStyleModalOpen] = useState(false);

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

  const [style, setStyle] = useState<StyleState>({
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
      setIsStyleModalOpen(false);
    } else if (fetcher.data?.action === "styleReset") {
      shopify.toast.show("Styles reset & synced to store");
      // Update local style state with defaults
      setStyle({
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
      });
      setIsStyleModalOpen(false);
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

  const handleStyleChange = (field: keyof StyleState, value: string | number) => {
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

      {/* Status & Schedule Section */}
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

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
            <div>
              <label style={{ display: "block", marginBottom: "4px", fontWeight: 500, fontSize: "14px" }}>Start date</label>
              <input
                type="datetime-local"
                style={{ width: "100%", padding: "8px 12px", borderRadius: "8px", border: "1px solid #8c9196", fontSize: "14px", backgroundColor: "#fff", boxSizing: "border-box" }}
                value={form.startDate}
                onChange={(e) => handleFormChange("startDate", e.target.value)}
              />
            </div>
            <div>
              <label style={{ display: "block", marginBottom: "4px", fontWeight: 500, fontSize: "14px" }}>End date</label>
              <input
                type="datetime-local"
                style={{ width: "100%", padding: "8px 12px", borderRadius: "8px", border: errors.endDate ? "1px solid #d72c0d" : "1px solid #8c9196", fontSize: "14px", backgroundColor: "#fff", boxSizing: "border-box" }}
                value={form.endDate}
                onChange={(e) => handleFormChange("endDate", e.target.value)}
              />
              {errors.endDate && (
                <span style={{ color: "#d72c0d", fontSize: "12px", marginTop: "4px", display: "block" }}>{errors.endDate}</span>
              )}
            </div>
          </div>
        </s-stack>
      </s-section>

      {/* Selection Mode Section */}
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

      {/* Product Targeting Section */}
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

      {/* Discount Combinations Section */}
      <s-section heading="Discount combinations">
        <s-stack direction="block" gap="base">
          <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "14px" }}>
            <input
              type="checkbox"
              checked={form.combineWithProductDiscounts === "COMBINE"}
              onChange={(e) => handleFormChange("combineWithProductDiscounts", e.target.checked ? "COMBINE" : "NOT_COMBINE")}
            />
            <span>Product discounts</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "14px" }}>
            <input
              type="checkbox"
              checked={form.combineWithOrderDiscounts === "COMBINE"}
              onChange={(e) => handleFormChange("combineWithOrderDiscounts", e.target.checked ? "COMBINE" : "NOT_COMBINE")}
            />
            <span>Order discounts</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "14px" }}>
            <input
              type="checkbox"
              checked={form.combineWithShippingDiscounts === "COMBINE"}
              onChange={(e) => handleFormChange("combineWithShippingDiscounts", e.target.checked ? "COMBINE" : "NOT_COMBINE")}
            />
            <span>Shipping discounts</span>
          </label>
        </s-stack>
      </s-section>

      {/* Add-ons Section */}
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

      {/* Preview Section with Styles Button - Aside */}
      <s-section slot="aside" heading="Preview">
        <s-stack direction="block" gap="base">
          <s-button ref={stylesButtonRef} variant="secondary" style={{ width: '100%' }}>
            Customize Styles
          </s-button>
          <WidgetPreview
            bundle={bundle}
            addOnSets={addOnSets}
            style={style}
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
          addOnSets={addOnSets}
        />
      )}
    </s-page>
  );
}

// Styles Modal Component
interface StylesModalProps {
  style: StyleState;
  onStyleChange: (field: keyof StyleState, value: string | number) => void;
  onClose: () => void;
  onSave: () => void;
  onReset: () => void;
  // Preview data
  bundle: BundleWithRelations;
  addOnSets: AddOnSetWithVariants[];
}

function StylesModal({ style, onStyleChange, onClose, onSave, onReset, bundle, addOnSets }: StylesModalProps) {
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
    flex: "0 0 55%",
    padding: "20px 24px",
    overflowY: "auto",
    borderRight: "1px solid #e0e0e0",
  };

  const rightPanelStyle: React.CSSProperties = {
    flex: "0 0 45%",
    padding: "20px 24px",
    backgroundColor: "#f6f6f7",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
  };

  const modalFooterStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    padding: "16px 24px",
    borderTop: "1px solid #e0e0e0",
    backgroundColor: "#fff",
  };

  const sectionStyle: React.CSSProperties = {
    marginBottom: "24px",
  };

  const sectionTitleStyle: React.CSSProperties = {
    fontSize: "14px",
    fontWeight: 600,
    marginBottom: "12px",
    color: "#202223",
  };

  const fieldRowStyle: React.CSSProperties = {
    display: "flex",
    gap: "12px",
    marginBottom: "12px",
  };

  const fieldStyle: React.CSSProperties = {
    flex: 1,
  };

  const labelStyle: React.CSSProperties = {
    display: "block",
    marginBottom: "4px",
    fontWeight: 500,
    fontSize: "13px",
    color: "#6d7175",
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 12px",
    borderRadius: "8px",
    border: "1px solid #8c9196",
    fontSize: "14px",
    backgroundColor: "#fff",
  };

  const colorInputStyle: React.CSSProperties = {
    width: "100%",
    height: "40px",
    padding: "4px",
    borderRadius: "8px",
    border: "1px solid #8c9196",
    backgroundColor: "#fff",
    cursor: "pointer",
  };

  return (
    <div style={modalOverlayStyle} onClick={onClose}>
      <div style={modalContentStyle} onClick={(e) => e.stopPropagation()}>
        <div style={modalHeaderStyle}>
          <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}>Widget Styles</h2>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", fontSize: "24px", cursor: "pointer", color: "#6d7175" }}
          >
            &times;
          </button>
        </div>

        <div style={modalBodyStyle}>
          {/* Left Panel - Style Controls */}
          <div style={leftPanelStyle}>
          {/* Colors Section */}
          <div style={sectionStyle}>
            <div style={sectionTitleStyle}>Colors</div>
            <div style={fieldRowStyle}>
              <div style={fieldStyle}>
                <label style={labelStyle}>Background</label>
                <input
                  type="color"
                  style={colorInputStyle}
                  value={style.backgroundColor}
                  onChange={(e) => onStyleChange("backgroundColor", e.target.value)}
                />
              </div>
              <div style={fieldStyle}>
                <label style={labelStyle}>Font</label>
                <input
                  type="color"
                  style={colorInputStyle}
                  value={style.fontColor}
                  onChange={(e) => onStyleChange("fontColor", e.target.value)}
                />
              </div>
            </div>
            <div style={fieldRowStyle}>
              <div style={fieldStyle}>
                <label style={labelStyle}>Button</label>
                <input
                  type="color"
                  style={colorInputStyle}
                  value={style.buttonColor}
                  onChange={(e) => onStyleChange("buttonColor", e.target.value)}
                />
              </div>
              <div style={fieldStyle}>
                <label style={labelStyle}>Button text</label>
                <input
                  type="color"
                  style={colorInputStyle}
                  value={style.buttonTextColor}
                  onChange={(e) => onStyleChange("buttonTextColor", e.target.value)}
                />
              </div>
            </div>
            <div style={fieldRowStyle}>
              <div style={fieldStyle}>
                <label style={labelStyle}>Discount badge</label>
                <input
                  type="color"
                  style={colorInputStyle}
                  value={style.discountBadgeColor}
                  onChange={(e) => onStyleChange("discountBadgeColor", e.target.value)}
                />
              </div>
              <div style={fieldStyle}>
                <label style={labelStyle}>Discount text</label>
                <input
                  type="color"
                  style={colorInputStyle}
                  value={style.discountTextColor}
                  onChange={(e) => onStyleChange("discountTextColor", e.target.value)}
                />
              </div>
            </div>
            <div style={fieldRowStyle}>
              <div style={fieldStyle}>
                <label style={labelStyle}>Border color</label>
                <input
                  type="color"
                  style={colorInputStyle}
                  value={style.borderColor}
                  onChange={(e) => onStyleChange("borderColor", e.target.value)}
                />
              </div>
              <div style={fieldStyle}></div>
            </div>
          </div>

          {/* Layout Section */}
          <div style={sectionStyle}>
            <div style={sectionTitleStyle}>Layout</div>
            <div style={fieldRowStyle}>
              <div style={fieldStyle}>
                <label style={labelStyle}>Layout type</label>
                <select
                  style={inputStyle}
                  value={style.layoutType}
                  onChange={(e) => onStyleChange("layoutType", e.target.value)}
                >
                  <option value="LIST">List</option>
                  <option value="GRID">Grid</option>
                </select>
              </div>
              <div style={fieldStyle}>
                <label style={labelStyle}>Image size</label>
                <select
                  style={inputStyle}
                  value={style.imageSize}
                  onChange={(e) => onStyleChange("imageSize", e.target.value)}
                >
                  <option value="SMALL">Small</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="LARGE">Large</option>
                </select>
              </div>
            </div>
            <div style={fieldRowStyle}>
              <div style={fieldStyle}>
                <label style={labelStyle}>Discount label style</label>
                <select
                  style={inputStyle}
                  value={style.discountLabelStyle}
                  onChange={(e) => onStyleChange("discountLabelStyle", e.target.value)}
                >
                  <option value="BADGE">Badge</option>
                  <option value="HIGHLIGHTED_TEXT">Highlighted text</option>
                </select>
              </div>
              <div style={fieldStyle}></div>
            </div>
          </div>

          {/* Typography Section */}
          <div style={sectionStyle}>
            <div style={sectionTitleStyle}>Typography</div>
            <div style={fieldRowStyle}>
              <div style={fieldStyle}>
                <label style={labelStyle}>Title font size (px)</label>
                <input
                  type="number"
                  style={inputStyle}
                  value={style.titleFontSize}
                  onChange={(e) => onStyleChange("titleFontSize", parseInt(e.target.value) || 18)}
                  min="10"
                  max="32"
                />
              </div>
              <div style={fieldStyle}>
                <label style={labelStyle}>Subtitle font size (px)</label>
                <input
                  type="number"
                  style={inputStyle}
                  value={style.subtitleFontSize}
                  onChange={(e) => onStyleChange("subtitleFontSize", parseInt(e.target.value) || 14)}
                  min="10"
                  max="24"
                />
              </div>
            </div>
            <div style={fieldRowStyle}>
              <div style={fieldStyle}>
                <label style={labelStyle}>Body font size (px)</label>
                <input
                  type="number"
                  style={inputStyle}
                  value={style.fontSize}
                  onChange={(e) => onStyleChange("fontSize", parseInt(e.target.value) || 14)}
                  min="10"
                  max="20"
                />
              </div>
              <div style={fieldStyle}></div>
            </div>
          </div>

          {/* Spacing & Borders Section */}
          <div style={sectionStyle}>
            <div style={sectionTitleStyle}>Spacing & Borders</div>
            <div style={fieldRowStyle}>
              <div style={fieldStyle}>
                <label style={labelStyle}>Border radius (px)</label>
                <input
                  type="number"
                  style={inputStyle}
                  value={style.borderRadius}
                  onChange={(e) => onStyleChange("borderRadius", parseInt(e.target.value) || 0)}
                  min="0"
                  max="24"
                />
              </div>
              <div style={fieldStyle}>
                <label style={labelStyle}>Border style</label>
                <select
                  style={inputStyle}
                  value={style.borderStyle}
                  onChange={(e) => onStyleChange("borderStyle", e.target.value)}
                >
                  <option value="NONE">None</option>
                  <option value="SOLID">Solid</option>
                  <option value="DASHED">Dashed</option>
                  <option value="DOTTED">Dotted</option>
                </select>
              </div>
            </div>
            <div style={fieldRowStyle}>
              <div style={fieldStyle}>
                <label style={labelStyle}>Border width (px)</label>
                <input
                  type="number"
                  style={inputStyle}
                  value={style.borderWidth}
                  onChange={(e) => onStyleChange("borderWidth", parseInt(e.target.value) || 0)}
                  min="0"
                  max="5"
                />
              </div>
              <div style={fieldStyle}>
                <label style={labelStyle}>Padding (px)</label>
                <input
                  type="number"
                  style={inputStyle}
                  value={style.padding}
                  onChange={(e) => onStyleChange("padding", parseInt(e.target.value) || 0)}
                  min="0"
                  max="48"
                />
              </div>
            </div>
            <div style={fieldRowStyle}>
              <div style={fieldStyle}>
                <label style={labelStyle}>Margin top (px)</label>
                <input
                  type="number"
                  style={inputStyle}
                  value={style.marginTop}
                  onChange={(e) => onStyleChange("marginTop", parseInt(e.target.value) || 0)}
                  min="0"
                  max="64"
                />
              </div>
              <div style={fieldStyle}>
                <label style={labelStyle}>Margin bottom (px)</label>
                <input
                  type="number"
                  style={inputStyle}
                  value={style.marginBottom}
                  onChange={(e) => onStyleChange("marginBottom", parseInt(e.target.value) || 0)}
                  min="0"
                  max="64"
                />
              </div>
            </div>
          </div>
          </div>

          {/* Right Panel - Live Preview */}
          <div style={rightPanelStyle}>
            <div style={{ marginBottom: "12px" }}>
              <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 600, color: "#202223" }}>Live Preview</h3>
              <p style={{ margin: "4px 0 0 0", fontSize: "12px", color: "#6d7175" }}>See how your widget will look</p>
            </div>
            <div style={{ flex: 1, display: "flex", alignItems: "flex-start" }}>
              <StylesModalPreview
                bundle={bundle}
                addOnSets={addOnSets}
                style={style}
              />
            </div>
          </div>
        </div>

        <div style={modalFooterStyle}>
          <button
            onClick={onReset}
            style={{
              padding: "8px 16px",
              borderRadius: "8px",
              border: "1px solid #8c9196",
              backgroundColor: "#fff",
              cursor: "pointer",
              fontSize: "14px",
              color: "#6d7175",
            }}
          >
            Reset to defaults
          </button>
          <button
            onClick={onSave}
            style={{
              padding: "8px 24px",
              borderRadius: "8px",
              border: "none",
              backgroundColor: "#008060",
              color: "#fff",
              cursor: "pointer",
              fontSize: "14px",
              fontWeight: 500,
            }}
          >
            Save Styles
          </button>
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
    backgroundColor: style.discountBadgeColor,
    color: style.discountTextColor,
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
                readOnly
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
  style: StyleState;
}

function WidgetPreview({ bundle, addOnSets, style }: WidgetPreviewProps) {
  const previewStyle: React.CSSProperties = {
    backgroundColor: style.backgroundColor,
    color: style.fontColor,
    borderRadius: `${style.borderRadius}px`,
    borderStyle: style.borderStyle === "NONE" ? "none" : style.borderStyle.toLowerCase(),
    borderWidth: `${style.borderWidth}px`,
    borderColor: style.borderColor,
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
    backgroundColor: style.discountBadgeColor,
    color: style.discountTextColor,
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
