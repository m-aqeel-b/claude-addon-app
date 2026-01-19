import { useEffect, useState, useRef, useCallback } from "react";
import { useFetcher, redirect } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { createBundle, bundleTitleExists, getBundle } from "../models/bundle.server";
import { createAddOnSet, setVariantsForSet } from "../models/addOnSet.server";
import { getOrCreateWidgetStyle, updateWidgetStyle } from "../models/widgetStyle.server";
import { addTargetedItem, createProductGroup, addProductGroupItem } from "../models/targeting.server";
import { buildWidgetConfig, syncShopMetafields, syncProductMetafields } from "../services/metafield.sync";
import { activateBundleDiscount } from "../services/discount.sync";
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
} from "@prisma/client";

// Local state types for managing data before submission
interface LocalAddOn {
  id: string; // temporary local ID
  shopifyProductId: string;
  productTitle: string;
  productImageUrl?: string;
  discountType: DiscountType;
  discountValue: number | null;
  discountLabel: string;
  isDefaultSelected: boolean;
  subscriptionOnly: boolean;
  showQuantitySelector: boolean;
  maxQuantity: number;
  selectedVariants: Array<{
    shopifyVariantId: string;
    variantTitle?: string;
    variantSku?: string;
    variantPrice?: number;
  }>;
}

interface LocalTargetedItem {
  id: string; // temporary local ID
  shopifyResourceId: string;
  shopifyResourceType: "Product" | "Collection";
  title: string;
  imageUrl?: string;
}

interface LocalProductGroup {
  id: string; // temporary local ID
  title: string;
  items: LocalTargetedItem[];
}

interface FormState {
  title: string;
  subtitle: string;
  status: BundleStatus;
  startDate: string;
  endDate: string;
  selectionMode: SelectionMode;
  targetingType: TargetingType;
  combineWithProductDiscounts: DiscountCombination;
  combineWithOrderDiscounts: DiscountCombination;
  combineWithShippingDiscounts: DiscountCombination;
}

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

const defaultFormState: FormState = {
  title: "",
  subtitle: "",
  status: "DRAFT",
  startDate: "",
  endDate: "",
  selectionMode: "MULTIPLE",
  targetingType: "ALL_PRODUCTS",
  combineWithProductDiscounts: "COMBINE",
  combineWithOrderDiscounts: "COMBINE",
  combineWithShippingDiscounts: "COMBINE",
};

const defaultStyleState: StyleState = {
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
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {};
};

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("Action called, method:", request.method);
  try {
    const { session, admin } = await authenticate.admin(request);
    const shop = session.shop;
    console.log("Authenticated shop:", shop);

    const formData = await request.formData();
    console.log("FormData entries:", Object.fromEntries(formData));

    // Parse basic bundle info
    const title = formData.get("title") as string;
    const subtitle = formData.get("subtitle") as string;
    const status = (formData.get("status") as BundleStatus) || "DRAFT";
    const startDate = formData.get("startDate") as string;
    const endDate = formData.get("endDate") as string;
    const selectionMode = (formData.get("selectionMode") as SelectionMode) || "MULTIPLE";
    const targetingType = (formData.get("targetingType") as TargetingType) || "ALL_PRODUCTS";
    const combineWithProductDiscounts = (formData.get("combineWithProductDiscounts") as DiscountCombination) || "COMBINE";
    const combineWithOrderDiscounts = (formData.get("combineWithOrderDiscounts") as DiscountCombination) || "COMBINE";
    const combineWithShippingDiscounts = (formData.get("combineWithShippingDiscounts") as DiscountCombination) || "COMBINE";

    // Parse add-ons, styles, targeting from JSON
    const addOnsJson = formData.get("addOns") as string;
    const styleJson = formData.get("style") as string;
    const targetedItemsJson = formData.get("targetedItems") as string;
    const productGroupsJson = formData.get("productGroups") as string;

    const addOns: LocalAddOn[] = addOnsJson ? JSON.parse(addOnsJson) : [];
    const style: StyleState = styleJson ? JSON.parse(styleJson) : defaultStyleState;
    const targetedItems: LocalTargetedItem[] = targetedItemsJson ? JSON.parse(targetedItemsJson) : [];
    const productGroups: LocalProductGroup[] = productGroupsJson ? JSON.parse(productGroupsJson) : [];

    // Validation
    const errors: Record<string, string> = {};

    if (!title || title.trim().length === 0) {
      errors.title = "Title is required";
    } else if (title.length > 100) {
      errors.title = "Title must be 100 characters or less";
    } else if (await bundleTitleExists(shop, title)) {
      errors.title = "A bundle with this title already exists";
    }

    if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
      errors.endDate = "End date must be after start date";
    }

    if (Object.keys(errors).length > 0) {
      return { errors };
    }

    // Create the bundle
    const bundle = await createBundle({
      shop,
      title: title.trim(),
      subtitle: subtitle.trim() || undefined,
      status,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      selectionMode,
      targetingType,
      combineWithProductDiscounts,
      combineWithOrderDiscounts,
      combineWithShippingDiscounts,
    });

    console.log("[createBundle] Bundle created:", bundle.id);

    // Create widget style
    const widgetStyle = await getOrCreateWidgetStyle(bundle.id);
    await updateWidgetStyle(bundle.id, style);
    console.log("[createBundle] Widget style created/updated");

    // Create add-on sets
    for (const addOn of addOns) {
      const addOnSet = await createAddOnSet({
        bundleId: bundle.id,
        shopifyProductId: addOn.shopifyProductId,
        productTitle: addOn.productTitle,
        productImageUrl: addOn.productImageUrl,
        discountType: addOn.discountType,
        discountValue: addOn.discountValue ?? undefined,
        discountLabel: addOn.discountLabel || undefined,
        isDefaultSelected: addOn.isDefaultSelected,
        subscriptionOnly: addOn.subscriptionOnly,
        showQuantitySelector: addOn.showQuantitySelector,
        maxQuantity: addOn.maxQuantity,
      });

      // Add variants to the add-on set
      if (addOn.selectedVariants.length > 0) {
        await setVariantsForSet(addOnSet.id, addOn.selectedVariants);
      }
      console.log("[createBundle] Add-on set created:", addOnSet.id);
    }

    // Create targeted items (for SPECIFIC_PRODUCTS)
    if (targetingType === "SPECIFIC_PRODUCTS") {
      for (const item of targetedItems) {
        await addTargetedItem({
          bundleId: bundle.id,
          shopifyResourceId: item.shopifyResourceId,
          shopifyResourceType: item.shopifyResourceType,
          title: item.title,
          imageUrl: item.imageUrl,
        });
      }
      console.log("[createBundle] Created", targetedItems.length, "targeted items");
    }

    // Create product groups (for PRODUCT_GROUPS)
    if (targetingType === "PRODUCT_GROUPS") {
      for (const group of productGroups) {
        const createdGroup = await createProductGroup({
          bundleId: bundle.id,
          title: group.title,
        });

        for (const item of group.items) {
          await addProductGroupItem({
            productGroupId: createdGroup.id,
            shopifyResourceId: item.shopifyResourceId,
            shopifyResourceType: item.shopifyResourceType,
            title: item.title,
            imageUrl: item.imageUrl,
          });
        }
      }
      console.log("[createBundle] Created", productGroups.length, "product groups");
    }

    // If bundle is created as ACTIVE, sync metafields and create discount
    let discountError: string | null = null;

    if (status === "ACTIVE") {
      console.log("[createBundle] Bundle created as ACTIVE, syncing metafields and creating discount");

      try {
        // Get the full bundle with relations
        const fullBundle = await getBundle(bundle.id, shop);
        if (fullBundle) {
          // Get the updated widget style
          const updatedWidgetStyle = await getOrCreateWidgetStyle(bundle.id);

          // Build widget config - need to get add-on sets from database
          const { getAddOnSets } = await import("../models/addOnSet.server");
          const dbAddOnSets = await getAddOnSets(bundle.id);

          const widgetConfig = buildWidgetConfig(fullBundle, dbAddOnSets, updatedWidgetStyle);

          // Get shop GID
          const shopResponse = await admin.graphql(`query { shop { id } }`);
          const shopResult = await shopResponse.json();
          const shopGid = (shopResult.data?.shop as { id?: string })?.id;

          if (shopGid && targetingType === "ALL_PRODUCTS") {
            console.log("[createBundle] Syncing to shop metafield");
            await syncShopMetafields(admin, shopGid, widgetConfig);
          } else if (targetingType === "SPECIFIC_PRODUCTS" && targetedItems.length > 0) {
            const productIds = targetedItems
              .filter((item) => item.shopifyResourceType === "Product")
              .map((item) => item.shopifyResourceId);
            if (productIds.length > 0) {
              console.log("[createBundle] Syncing to", productIds.length, "product metafields");
              await syncProductMetafields(admin, productIds, widgetConfig);
            }
          }

          // Create the Shopify automatic discount
          console.log("[createBundle] Creating Shopify discount");
          const discountResult = await activateBundleDiscount(admin, shop, fullBundle);
          if (discountResult.errors.length > 0) {
            console.error("[createBundle] Discount creation errors:", discountResult.errors);
            discountError = discountResult.errors.map(e => e.message).join(", ");
          } else {
            console.log("[createBundle] Discount created successfully");
          }
        }
      } catch (syncError) {
        console.error("[createBundle] Error syncing/creating discount:", syncError);
        discountError = syncError instanceof Error ? syncError.message : "Unknown error creating discount";
      }
    }

    // Use server-side redirect for reliable navigation in embedded apps
    const redirectUrl = discountError
      ? `/app/bundles/${bundle.id}?discountError=${encodeURIComponent(discountError)}`
      : `/app/bundles/${bundle.id}?created=true`;

    throw redirect(redirectUrl);
  } catch (error) {
    // Don't catch redirect throws
    if (error instanceof Response) {
      throw error;
    }
    console.error("Error creating bundle:", error);
    return { errors: { _form: "An error occurred while creating the bundle. Please try again." } };
  }
};

export default function NewBundle() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const submitButtonRef = useRef<HTMLElement>(null);

  // Form state
  const [form, setForm] = useState<FormState>(defaultFormState);
  const [style, setStyle] = useState<StyleState>(defaultStyleState);
  const [addOns, setAddOns] = useState<LocalAddOn[]>([]);
  const [targetedItems, setTargetedItems] = useState<LocalTargetedItem[]>([]);
  const [productGroups, setProductGroups] = useState<LocalProductGroup[]>([]);
  const [newGroupTitle, setNewGroupTitle] = useState("");

  // Style modal state
  const [isStyleModalOpen, setIsStyleModalOpen] = useState(false);

  // Refs
  const addProductButtonRef = useRef<HTMLElement>(null);
  const stylesButtonRef = useRef<HTMLElement>(null);

  const isSubmitting = fetcher.state === "submitting";
  const errors = fetcher.data?.errors || {};

  // Handle validation errors
  useEffect(() => {
    if (fetcher.data?.errors) {
      shopify.toast.show("Please fix the errors and try again", { isError: true });
    }
  }, [fetcher.data, shopify]);

  const handleChange = (field: keyof FormState, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleStyleChange = (field: keyof StyleState, value: string | number) => {
    setStyle((prev) => ({ ...prev, [field]: value }));
  };

  // Generate a temporary local ID
  const generateLocalId = () => `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Add-on management
  const openProductPicker = useCallback(async () => {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: false,
      selectionIds: [],
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

      const newAddOn: LocalAddOn = {
        id: generateLocalId(),
        shopifyProductId: product.id,
        productTitle: product.title,
        productImageUrl: product.images?.[0]?.originalSrc,
        discountType: "PERCENTAGE",
        discountValue: null,
        discountLabel: "",
        isDefaultSelected: false,
        subscriptionOnly: false,
        showQuantitySelector: false,
        maxQuantity: 10,
        selectedVariants: selectedVariants.map(v => ({
          shopifyVariantId: v.id,
          variantTitle: v.title,
          variantSku: v.sku || undefined,
          variantPrice: v.price ? parseFloat(v.price) : undefined,
        })),
      };

      setAddOns(prev => [...prev, newAddOn]);
      shopify.toast.show("Product added as add-on");
    }
  }, [shopify]);

  const updateAddOn = (localId: string, updates: Partial<LocalAddOn>) => {
    setAddOns(prev => prev.map(addOn =>
      addOn.id === localId ? { ...addOn, ...updates } : addOn
    ));
  };

  const removeAddOn = (localId: string) => {
    setAddOns(prev => prev.filter(addOn => addOn.id !== localId));
    shopify.toast.show("Add-on removed");
  };

  // Edit variants for an add-on
  const openVariantEditor = useCallback(async (localId: string, productId: string, currentVariantIds: string[]) => {
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
        updateAddOn(localId, {
          selectedVariants: selectedVariants.map(v => ({
            shopifyVariantId: v.id,
            variantTitle: v.title,
            variantSku: v.sku || undefined,
            variantPrice: v.price ? parseFloat(v.price) : undefined,
          })),
        });
        shopify.toast.show("Variants updated");
      }
    }
  }, [shopify]);

  // Targeting management
  const openTargetedResourcePicker = async (type: "product" | "collection") => {
    const selected = await shopify.resourcePicker({ type, multiple: true });
    if (selected && selected.length > 0) {
      const newItems: LocalTargetedItem[] = selected.map(resource => ({
        id: generateLocalId(),
        shopifyResourceId: resource.id,
        shopifyResourceType: type === "product" ? "Product" : "Collection",
        title: resource.title,
        imageUrl: (resource as { images?: { originalSrc?: string }[] }).images?.[0]?.originalSrc,
      }));

      setTargetedItems(prev => [...prev, ...newItems]);
      shopify.toast.show(`${selected.length} ${type}(s) added`);
    }
  };

  const removeTargetedItem = (localId: string) => {
    setTargetedItems(prev => prev.filter(item => item.id !== localId));
  };

  // Product group management
  const handleCreateProductGroup = () => {
    if (newGroupTitle.trim()) {
      const newGroup: LocalProductGroup = {
        id: generateLocalId(),
        title: newGroupTitle.trim(),
        items: [],
      };
      setProductGroups(prev => [...prev, newGroup]);
      setNewGroupTitle("");
      shopify.toast.show("Group created");
    }
  };

  const handleDeleteProductGroup = (groupId: string) => {
    setProductGroups(prev => prev.filter(g => g.id !== groupId));
    shopify.toast.show("Group deleted");
  };

  const openGroupResourcePicker = async (groupId: string) => {
    const selected = await shopify.resourcePicker({ type: "product", multiple: true });
    if (selected && selected.length > 0) {
      const newItems: LocalTargetedItem[] = selected.map(resource => ({
        id: generateLocalId(),
        shopifyResourceId: resource.id,
        shopifyResourceType: "Product",
        title: resource.title,
        imageUrl: (resource as { images?: { originalSrc?: string }[] }).images?.[0]?.originalSrc,
      }));

      setProductGroups(prev => prev.map(group =>
        group.id === groupId
          ? { ...group, items: [...group.items, ...newItems] }
          : group
      ));
      shopify.toast.show(`${selected.length} product(s) added to group`);
    }
  };

  const removeProductGroupItem = (groupId: string, itemId: string) => {
    setProductGroups(prev => prev.map(group =>
      group.id === groupId
        ? { ...group, items: group.items.filter(item => item.id !== itemId) }
        : group
    ));
  };

  // Reset styles to defaults
  const handleResetStyles = () => {
    if (confirm("Reset all styles to defaults?")) {
      setStyle(defaultStyleState);
      shopify.toast.show("Styles reset to defaults");
    }
  };

  // Submit handler
  const handleSubmit = useCallback(() => {
    console.log("handleSubmit called");

    const formData = new FormData();

    // Add basic form fields
    Object.entries(form).forEach(([key, value]) => {
      formData.append(key, value);
    });

    // Add JSON data for complex structures
    formData.append("addOns", JSON.stringify(addOns));
    formData.append("style", JSON.stringify(style));
    formData.append("targetedItems", JSON.stringify(targetedItems));
    formData.append("productGroups", JSON.stringify(productGroups));

    console.log("Submitting with", addOns.length, "add-ons");
    fetcher.submit(formData, { method: "POST" });
  }, [form, addOns, style, targetedItems, productGroups, fetcher]);

  // Attach event listeners for web component buttons
  useEffect(() => {
    const button = submitButtonRef.current;
    if (button) {
      button.addEventListener("click", handleSubmit);
      return () => button.removeEventListener("click", handleSubmit);
    }
  }, [handleSubmit]);

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

  return (
    <s-page
      heading="Create bundle"
      back-action="/app/bundles"
    >
      <s-button
        ref={submitButtonRef}
        slot="primary-action"
        variant="primary"
        loading={isSubmitting || undefined}
        disabled={isSubmitting || undefined}
      >
        {isSubmitting ? "Creating..." : "Create bundle"}
      </s-button>

      {errors._form && (
        <s-section>
          <s-box padding="base" background="critical">
            <s-text color="critical">{errors._form}</s-text>
          </s-box>
        </s-section>
      )}

      {/* Basic Information Section */}
      <s-section heading="Basic information">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Title"
            value={form.title}
            onInput={(e: Event) => handleChange("title", (e.target as HTMLInputElement).value)}
            error={errors.title}
            required
            placeholder="e.g., Holiday Add-Ons"
          />
          <s-text-field
            label="Subtitle"
            value={form.subtitle}
            onInput={(e: Event) => handleChange("subtitle", (e.target as HTMLInputElement).value)}
            placeholder="Optional description shown to customers"
          />
        </s-stack>
      </s-section>

      {/* Status & Schedule Section */}
      <s-section heading="Status & Schedule">
        <s-stack direction="block" gap="base">
          <div>
            <label style={{ display: "block", marginBottom: "4px", fontWeight: 500 }}>Status</label>
            <select
              value={form.status}
              onChange={(e) => handleChange("status", e.target.value)}
              style={{
                width: "100%",
                padding: "8px 12px",
                borderRadius: "8px",
                border: "1px solid #8c9196",
                fontSize: "14px",
                backgroundColor: "#fff",
              }}
            >
              <option value="DRAFT">Draft</option>
              <option value="ACTIVE">Active</option>
            </select>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
            <div>
              <label style={{ display: "block", marginBottom: "4px", fontWeight: 500 }}>Start date (optional)</label>
              <input
                type="datetime-local"
                value={form.startDate}
                onChange={(e) => handleChange("startDate", e.target.value)}
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
            <div>
              <label style={{ display: "block", marginBottom: "4px", fontWeight: 500 }}>End date (optional)</label>
              <input
                type="datetime-local"
                value={form.endDate}
                onChange={(e) => handleChange("endDate", e.target.value)}
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
                <span style={{ color: "#d72c0d", fontSize: "12px", marginTop: "4px", display: "block" }}>
                  {errors.endDate}
                </span>
              )}
            </div>
          </div>
        </s-stack>
      </s-section>

      {/* Customer Selection Section */}
      <s-section heading="Customer selection">
        <s-stack direction="block" gap="base">
          <div>
            <label style={{ display: "block", marginBottom: "8px", fontWeight: 500 }}>Selection mode</label>
            <s-stack direction="block" gap="tight">
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="selectionMode"
                  value="MULTIPLE"
                  checked={form.selectionMode === "MULTIPLE"}
                  onChange={(e) => handleChange("selectionMode", e.target.value)}
                />
                <span>Multiple - Customers can select multiple add-ons</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="selectionMode"
                  value="SINGLE"
                  checked={form.selectionMode === "SINGLE"}
                  onChange={(e) => handleChange("selectionMode", e.target.value)}
                />
                <span>Single - Customers can select only one add-on</span>
              </label>
            </s-stack>
          </div>
        </s-stack>
      </s-section>

      {/* Product Targeting Section */}
      <s-section heading="Product targeting">
        <s-stack direction="block" gap="base">
          <div>
            <label style={{ display: "block", marginBottom: "8px", fontWeight: 500 }}>Which products should show this bundle?</label>
            <s-stack direction="block" gap="tight">
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="targetingType"
                  value="ALL_PRODUCTS"
                  checked={form.targetingType === "ALL_PRODUCTS"}
                  onChange={(e) => handleChange("targetingType", e.target.value)}
                />
                <span>All products</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="targetingType"
                  value="SPECIFIC_PRODUCTS"
                  checked={form.targetingType === "SPECIFIC_PRODUCTS"}
                  onChange={(e) => handleChange("targetingType", e.target.value)}
                />
                <span>Specific products or collections</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="targetingType"
                  value="PRODUCT_GROUPS"
                  checked={form.targetingType === "PRODUCT_GROUPS"}
                  onChange={(e) => handleChange("targetingType", e.target.value)}
                />
                <span>Product groups (with tabs)</span>
              </label>
            </s-stack>
          </div>

          {/* Description and targeting UI based on type */}
          {form.targetingType === "ALL_PRODUCTS" && (
            <s-text color="subdued">Add-ons will appear on all product pages.</s-text>
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
                          <s-text style={{ flex: 1 }}>{item.title}</s-text>
                          <button
                            style={{ background: "none", border: "none", color: "#d72c0d", cursor: "pointer", fontSize: "14px" }}
                            onClick={() => removeTargetedItem(item.id)}
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
                              onClick={() => handleDeleteProductGroup(group.id)}
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
                                      onClick={() => removeProductGroupItem(group.id, item.id)}
                                    >
                                      x
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
              onChange={(e) => handleChange("combineWithProductDiscounts", e.target.checked ? "COMBINE" : "NOT_COMBINE")}
            />
            <span>Product discounts</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "14px" }}>
            <input
              type="checkbox"
              checked={form.combineWithOrderDiscounts === "COMBINE"}
              onChange={(e) => handleChange("combineWithOrderDiscounts", e.target.checked ? "COMBINE" : "NOT_COMBINE")}
            />
            <span>Order discounts</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "14px" }}>
            <input
              type="checkbox"
              checked={form.combineWithShippingDiscounts === "COMBINE"}
              onChange={(e) => handleChange("combineWithShippingDiscounts", e.target.checked ? "COMBINE" : "NOT_COMBINE")}
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

          {addOns.length === 0 ? (
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
              {addOns.map((addOn) => (
                <AddOnCard
                  key={addOn.id}
                  addOn={addOn}
                  onDelete={() => removeAddOn(addOn.id)}
                  onUpdate={(updates) => updateAddOn(addOn.id, updates)}
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
            title={form.title}
            subtitle={form.subtitle}
            selectionMode={form.selectionMode}
            addOns={addOns}
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
          onReset={handleResetStyles}
          title={form.title}
          subtitle={form.subtitle}
          selectionMode={form.selectionMode}
          addOns={addOns}
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
  onReset: () => void;
  // Preview data
  title: string;
  subtitle: string;
  selectionMode: string;
  addOns: LocalAddOn[];
}

function StylesModal({ style, onStyleChange, onClose, onReset, title, subtitle, selectionMode, addOns }: StylesModalProps) {
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
                title={title}
                subtitle={subtitle}
                selectionMode={selectionMode}
                addOns={addOns}
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
            onClick={onClose}
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
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// Preview component for inside the styles modal
interface StylesModalPreviewProps {
  title: string;
  subtitle: string;
  selectionMode: string;
  addOns: LocalAddOn[];
  style: StyleState;
}

function StylesModalPreview({ title, subtitle, selectionMode, addOns, style }: StylesModalPreviewProps) {
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
      <div style={titleStyle}>{title || "Bundle Title"}</div>
      {subtitle && <div style={subtitleStyle}>{subtitle}</div>}

      {addOns.length === 0 ? (
        <div style={{ opacity: 0.6, textAlign: "center", padding: "20px" }}>
          No add-ons configured
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: style.layoutType === "GRID" ? "row" : "column", gap: "12px", flexWrap: "wrap" }}>
          {addOns.slice(0, 3).map((addOn) => (
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
                type={selectionMode === "SINGLE" ? "radio" : "checkbox"}
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
          {addOns.length > 3 && (
            <div style={{ opacity: 0.6, fontSize: "12px" }}>
              +{addOns.length - 3} more add-ons
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Add-On Card Component for local management
interface AddOnCardProps {
  addOn: LocalAddOn;
  onDelete: () => void;
  onUpdate: (updates: Partial<LocalAddOn>) => void;
  onEditVariants: () => void;
}

function AddOnCard({ addOn, onDelete, onUpdate, onEditVariants }: AddOnCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

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
              {addOn.discountType === "FREE_GIFT" ? "Free gift" : `${addOn.discountType.replace(/_/g, " ")}${addOn.discountValue ? `: ${addOn.discountValue}` : ""}`}
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
                value={addOn.discountType}
                onChange={(e) => onUpdate({ discountType: e.target.value as DiscountType })}
              >
                <option value="PERCENTAGE">Percentage</option>
                <option value="FIXED_AMOUNT">Fixed amount off</option>
                <option value="FIXED_PRICE">Fixed price</option>
                <option value="FREE_GIFT">Free gift (100% off)</option>
              </select>
            </div>

            {addOn.discountType !== "FREE_GIFT" && (
              <div>
                <label style={labelStyle}>
                  {addOn.discountType === "PERCENTAGE" ? "Discount percentage" : "Discount amount"}
                </label>
                <input
                  type="number"
                  style={inputStyle}
                  value={addOn.discountValue || ""}
                  onChange={(e) => onUpdate({ discountValue: e.target.value ? parseFloat(e.target.value) : null })}
                  min="0"
                  step={addOn.discountType === "PERCENTAGE" ? "1" : "0.01"}
                />
              </div>
            )}

            <div>
              <label style={labelStyle}>Discount label (optional)</label>
              <input
                type="text"
                style={inputStyle}
                value={addOn.discountLabel}
                onChange={(e) => onUpdate({ discountLabel: e.target.value })}
                placeholder="e.g., Save 20%"
              />
            </div>

            <label style={checkboxLabelStyle}>
              <input
                type="checkbox"
                checked={addOn.isDefaultSelected}
                onChange={(e) => onUpdate({ isDefaultSelected: e.target.checked })}
                disabled={addOn.discountType === "FREE_GIFT"}
              />
              <span>Pre-selected by default</span>
            </label>

            <label style={checkboxLabelStyle}>
              <input
                type="checkbox"
                checked={addOn.subscriptionOnly}
                onChange={(e) => onUpdate({ subscriptionOnly: e.target.checked })}
              />
              <span>Subscription orders only</span>
            </label>

            <label style={checkboxLabelStyle}>
              <input
                type="checkbox"
                checked={addOn.showQuantitySelector}
                onChange={(e) => onUpdate({ showQuantitySelector: e.target.checked })}
              />
              <span>Show quantity selector</span>
            </label>

            {addOn.showQuantitySelector && (
              <div>
                <label style={labelStyle}>Maximum quantity</label>
                <input
                  type="number"
                  style={inputStyle}
                  value={addOn.maxQuantity}
                  onChange={(e) => onUpdate({ maxQuantity: parseInt(e.target.value) || 1 })}
                  min="1"
                  max="99"
                />
              </div>
            )}

            <s-stack direction="inline" gap="tight" align="center">
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
  title: string;
  subtitle: string;
  selectionMode: SelectionMode;
  addOns: LocalAddOn[];
  style: StyleState;
}

function WidgetPreview({ title, subtitle, selectionMode, addOns, style }: WidgetPreviewProps) {
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
      <div style={titleStyle}>{title || "Bundle Title"}</div>
      {subtitle && <div style={subtitleStyle}>{subtitle}</div>}

      {addOns.length === 0 ? (
        <div style={{ opacity: 0.6, textAlign: "center", padding: "20px" }}>
          No add-ons configured
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: style.layoutType === "GRID" ? "row" : "column", gap: "12px", flexWrap: "wrap" }}>
          {addOns.slice(0, 3).map((addOn) => (
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
                type={selectionMode === "SINGLE" ? "radio" : "checkbox"}
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
          {addOns.length > 3 && (
            <div style={{ opacity: 0.6, fontSize: "12px" }}>
              +{addOns.length - 3} more add-ons
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
