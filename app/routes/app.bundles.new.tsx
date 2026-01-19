import { useEffect, useState, useRef, useCallback } from "react";
import { useFetcher, redirect } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { createBundle, bundleTitleExists, getBundle } from "../models/bundle.server";
import { createAddOnSet, setVariantsForSet } from "../models/addOnSet.server";
import { getOrCreateWidgetStyle, updateWidgetStyle } from "../models/widgetStyle.server";
import { addTargetedItem } from "../models/targeting.server";
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

    const addOns: LocalAddOn[] = addOnsJson ? JSON.parse(addOnsJson) : [];
    const style: StyleState = styleJson ? JSON.parse(styleJson) : defaultStyleState;
    const targetedItems: LocalTargetedItem[] = targetedItemsJson ? JSON.parse(targetedItemsJson) : [];

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

  // Style modal state
  const [isStyleModalOpen, setIsStyleModalOpen] = useState(false);

  // Targeted item delete confirmation state
  const [targetedItemToDelete, setTargetedItemToDelete] = useState<LocalTargetedItem | null>(null);

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

    console.log("Submitting with", addOns.length, "add-ons");
    fetcher.submit(formData, { method: "POST" });
  }, [form, addOns, style, targetedItems, fetcher]);

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

      {/* Schedule Section */}
      <s-section heading="Schedule">
        <s-stack direction="inline" gap="base">
          <div style={{ flex: 1 }}>
            <s-text variant="bodyMd" style={{ display: "block", marginBottom: "4px" }}>Start date (optional)</s-text>
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
          <div style={{ flex: 1 }}>
            <s-text variant="bodyMd" style={{ display: "block", marginBottom: "4px" }}>End date (optional)</s-text>
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
              <s-text variant="bodySm" color="critical" style={{ marginTop: "4px" }}>{errors.endDate}</s-text>
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
            onInput={(e: Event) => handleChange("targetingType", (e.target as HTMLSelectElement).value)}
          >
            <s-option value="ALL_PRODUCTS" selected={form.targetingType === "ALL_PRODUCTS"}>All products</s-option>
            <s-option value="SPECIFIC_PRODUCTS" selected={form.targetingType === "SPECIFIC_PRODUCTS"}>Specific products or collections</s-option>
          </s-select>

          {/* Description and targeting UI based on type */}
          {form.targetingType === "ALL_PRODUCTS" && (
            <s-text color="subdued">Add-ons will appear on all product pages.</s-text>
          )}

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

                {targetedItems.length === 0 ? (
                  <s-text color="subdued" variant="bodySm">
                    No products or collections selected yet.
                  </s-text>
                ) : (
                  <s-stack direction="block" gap="tight">
                    {targetedItems.map((item) => (
                      <s-box key={item.id} padding="base" borderWidth="base" borderRadius="base" background="default">
                        <div style={{ display: "flex", alignItems: "center", gap: "12px", width: "100%" }}>
                          {/* Image */}
                          {item.imageUrl ? (
                            <img
                              src={item.imageUrl}
                              alt={item.title}
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
                              <s-text variant="headingSm">{item.title}</s-text>
                              <s-badge tone={item.shopifyResourceType === "Product" ? "info" : "success"}>
                                {item.shopifyResourceType}
                              </s-badge>
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
          onInput={(e: Event) => handleChange("status", (e.target as HTMLSelectElement).value)}
        >
          <s-option value="DRAFT" selected={form.status === "DRAFT"}>Draft</s-option>
          <s-option value="ACTIVE" selected={form.status === "ACTIVE"}>Active</s-option>
        </s-select>
      </s-section>

      {/* Customer Selection Section - Aside */}
      <s-section slot="aside" heading="Customer selection">
        <s-select
          label="Selection mode"
          value={form.selectionMode}
          onInput={(e: Event) => handleChange("selectionMode", (e.target as HTMLSelectElement).value)}
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
            onChange={(e: Event) => handleChange("combineWithProductDiscounts", (e.target as HTMLInputElement).checked ? "COMBINE" : "NOT_COMBINE")}
          />
          <s-checkbox
            label="Order discounts"
            checked={form.combineWithOrderDiscounts === "COMBINE"}
            onChange={(e: Event) => handleChange("combineWithOrderDiscounts", (e.target as HTMLInputElement).checked ? "COMBINE" : "NOT_COMBINE")}
          />
          <s-checkbox
            label="Shipping discounts"
            checked={form.combineWithShippingDiscounts === "COMBINE"}
            onChange={(e: Event) => handleChange("combineWithShippingDiscounts", (e.target as HTMLInputElement).checked ? "COMBINE" : "NOT_COMBINE")}
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

      {/* Targeted Item Delete Confirmation Modal */}
      {targetedItemToDelete && (
        <DeleteTargetedItemModal
          item={targetedItemToDelete}
          onConfirm={() => {
            removeTargetedItem(targetedItemToDelete.id);
            setTargetedItemToDelete(null);
          }}
          onCancel={() => setTargetedItemToDelete(null)}
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
  const resetButtonRef = useRef<HTMLElement>(null);
  const doneButtonRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const resetBtn = resetButtonRef.current;
    if (resetBtn) {
      resetBtn.addEventListener("click", onReset);
      return () => resetBtn.removeEventListener("click", onReset);
    }
  }, [onReset]);

  useEffect(() => {
    const doneBtn = doneButtonRef.current;
    if (doneBtn) {
      doneBtn.addEventListener("click", onClose);
      return () => doneBtn.removeEventListener("click", onClose);
    }
  }, [onClose]);

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

  const colorInputStyle: React.CSSProperties = {
    width: "100%",
    height: "36px",
    padding: "2px",
    borderRadius: "8px",
    border: "1px solid #8c9196",
    backgroundColor: "#fff",
    cursor: "pointer",
  };

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
            {/* Colors Section */}
            <div style={{ marginBottom: "24px" }}>
              <s-stack direction="block" gap="base">
                <s-text variant="headingSm">Colors</s-text>
                <s-stack direction="inline" gap="base">
                  <div style={{ flex: 1 }}>
                    <s-text variant="bodySm" color="subdued">Background</s-text>
                    <input
                      type="color"
                      style={colorInputStyle}
                      value={style.backgroundColor}
                      onChange={(e) => onStyleChange("backgroundColor", e.target.value)}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <s-text variant="bodySm" color="subdued">Font</s-text>
                    <input
                      type="color"
                      style={colorInputStyle}
                      value={style.fontColor}
                      onChange={(e) => onStyleChange("fontColor", e.target.value)}
                    />
                  </div>
                </s-stack>
                <s-stack direction="inline" gap="base">
                  <div style={{ flex: 1 }}>
                    <s-text variant="bodySm" color="subdued">Button</s-text>
                    <input
                      type="color"
                      style={colorInputStyle}
                      value={style.buttonColor}
                      onChange={(e) => onStyleChange("buttonColor", e.target.value)}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <s-text variant="bodySm" color="subdued">Button text</s-text>
                    <input
                      type="color"
                      style={colorInputStyle}
                      value={style.buttonTextColor}
                      onChange={(e) => onStyleChange("buttonTextColor", e.target.value)}
                    />
                  </div>
                </s-stack>
                <s-stack direction="inline" gap="base">
                  <div style={{ flex: 1 }}>
                    <s-text variant="bodySm" color="subdued">Discount badge</s-text>
                    <input
                      type="color"
                      style={colorInputStyle}
                      value={style.discountBadgeColor}
                      onChange={(e) => onStyleChange("discountBadgeColor", e.target.value)}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <s-text variant="bodySm" color="subdued">Discount text</s-text>
                    <input
                      type="color"
                      style={colorInputStyle}
                      value={style.discountTextColor}
                      onChange={(e) => onStyleChange("discountTextColor", e.target.value)}
                    />
                  </div>
                </s-stack>
                <s-stack direction="inline" gap="base">
                  <div style={{ flex: 1 }}>
                    <s-text variant="bodySm" color="subdued">Border color</s-text>
                    <input
                      type="color"
                      style={colorInputStyle}
                      value={style.borderColor}
                      onChange={(e) => onStyleChange("borderColor", e.target.value)}
                    />
                  </div>
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
            <div style={{ marginBottom: "12px" }}>
              <s-text variant="headingSm">Live Preview</s-text>
              <s-text variant="bodySm" color="subdued">See how your widget will look</s-text>
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
          <s-button ref={resetButtonRef} variant="tertiary">
            Reset to defaults
          </s-button>
          <s-button ref={doneButtonRef} variant="primary">
            Done
          </s-button>
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
            <img src={addOn.productImageUrl} alt={addOn.productTitle} style={productImageStyle} />
          ) : (
            <div style={placeholderImageStyle}>No image</div>
          )}

          {/* Product Title and Discount Info */}
          <div style={{ flex: 1 }}>
            <s-text variant="headingSm">{addOn.productTitle || "Untitled product"}</s-text>
            <div style={{ marginTop: "4px" }}>
              <span style={discountBadgeStyle}>{getDiscountText()}</span>
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
        <ConfigureAddOnModal
          addOn={addOn}
          onUpdate={onUpdate}
          onEditVariants={onEditVariants}
          onClose={() => setIsConfigureModalOpen(false)}
        />
      )}

      {/* Delete Confirmation Modal */}
      {isDeleteModalOpen && (
        <DeleteConfirmModal
          productTitle={addOn.productTitle}
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

// Configure Add-On Modal Component
interface ConfigureAddOnModalProps {
  addOn: LocalAddOn;
  onUpdate: (updates: Partial<LocalAddOn>) => void;
  onEditVariants: () => void;
  onClose: () => void;
}

function ConfigureAddOnModal({ addOn, onUpdate, onEditVariants, onClose }: ConfigureAddOnModalProps) {
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
                  alt={addOn.productTitle}
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
              value={addOn.discountType}
              onInput={(e: Event) => onUpdate({ discountType: (e.target as HTMLSelectElement).value as DiscountType })}
            >
              <s-option value="PERCENTAGE" selected={addOn.discountType === "PERCENTAGE"}>Percentage</s-option>
              <s-option value="FIXED_AMOUNT" selected={addOn.discountType === "FIXED_AMOUNT"}>Fixed amount off</s-option>
              <s-option value="FIXED_PRICE" selected={addOn.discountType === "FIXED_PRICE"}>Fixed price</s-option>
              <s-option value="FREE_GIFT" selected={addOn.discountType === "FREE_GIFT"}>Free gift (100% off)</s-option>
            </s-select>

            {/* Discount Value */}
            {addOn.discountType !== "FREE_GIFT" && (
              <s-text-field
                label={addOn.discountType === "PERCENTAGE" ? "Discount percentage" : "Discount amount"}
                type="number"
                value={addOn.discountValue?.toString() || ""}
                onInput={(e: Event) => {
                  const val = (e.target as HTMLInputElement).value;
                  onUpdate({ discountValue: val ? parseFloat(val) : null });
                }}
                min="0"
                step={addOn.discountType === "PERCENTAGE" ? "1" : "0.01"}
              />
            )}

            {/* Discount Label */}
            <s-text-field
              label="Discount label (optional)"
              value={addOn.discountLabel}
              onInput={(e: Event) => onUpdate({ discountLabel: (e.target as HTMLInputElement).value })}
              placeholder="e.g., Save 20%"
            />

            {/* Checkboxes */}
            <s-stack direction="block" gap="tight">
              <s-checkbox
                label="Pre-selected by default"
                checked={addOn.isDefaultSelected}
                disabled={addOn.discountType === "FREE_GIFT" || undefined}
                onChange={(e: Event) => onUpdate({ isDefaultSelected: (e.target as HTMLInputElement).checked })}
              />
              <s-checkbox
                label="Subscription orders only"
                checked={addOn.subscriptionOnly}
                onChange={(e: Event) => onUpdate({ subscriptionOnly: (e.target as HTMLInputElement).checked })}
              />
              <s-checkbox
                label="Show quantity selector"
                checked={addOn.showQuantitySelector}
                onChange={(e: Event) => onUpdate({ showQuantitySelector: (e.target as HTMLInputElement).checked })}
              />
            </s-stack>

            {/* Max Quantity */}
            {addOn.showQuantitySelector && (
              <s-text-field
                label="Maximum quantity"
                type="number"
                value={addOn.maxQuantity.toString()}
                onInput={(e: Event) => onUpdate({ maxQuantity: parseInt((e.target as HTMLInputElement).value) || 1 })}
                min="1"
                max="99"
              />
            )}
          </s-stack>
        </div>

        <div style={modalFooterStyle}>
          <s-button variant="primary" onClick={onClose}>
            Done
          </s-button>
        </div>
      </div>
    </div>
  );
}

// Delete Confirmation Modal Component
interface DeleteConfirmModalProps {
  productTitle: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function DeleteConfirmModal({ productTitle, onConfirm, onCancel }: DeleteConfirmModalProps) {
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
    borderRadius: "12px",
    width: "90%",
    maxWidth: "400px",
    padding: "24px",
    boxShadow: "0 4px 24px rgba(0, 0, 0, 0.2)",
    textAlign: "center",
  };

  const buttonContainerStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "center",
    gap: "12px",
    marginTop: "20px",
  };

  return (
    <div style={modalOverlayStyle} onClick={onCancel}>
      <div style={modalContentStyle} onClick={(e) => e.stopPropagation()}>
        <s-text variant="headingMd">Remove Add-On Product</s-text>
        <div style={{ marginTop: "12px", marginBottom: "8px" }}>
          <s-text color="subdued">
            Are you sure you want to delete this add-on product?
          </s-text>
        </div>
        <s-text variant="bodyMd">"{productTitle || "Untitled product"}"</s-text>
        <div style={buttonContainerStyle}>
          <s-button variant="secondary" onClick={onCancel}>
            No
          </s-button>
          <s-button variant="primary" tone="critical" onClick={onConfirm}>
            Yes
          </s-button>
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
    borderRadius: "12px",
    width: "90%",
    maxWidth: "400px",
    padding: "24px",
    boxShadow: "0 4px 24px rgba(0, 0, 0, 0.2)",
    textAlign: "center",
  };

  const buttonContainerStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "center",
    gap: "12px",
    marginTop: "20px",
  };

  return (
    <div style={modalOverlayStyle} onClick={onCancel}>
      <div style={modalContentStyle} onClick={(e) => e.stopPropagation()}>
        <s-text variant="headingMd">Remove {item.shopifyResourceType}</s-text>
        <div style={{ marginTop: "12px", marginBottom: "8px" }}>
          <s-text color="subdued">
            Are you sure you want to remove this {item.shopifyResourceType.toLowerCase()} from targeting?
          </s-text>
        </div>
        <s-text variant="bodyMd">"{item.title}"</s-text>
        <div style={buttonContainerStyle}>
          <s-button variant="secondary" onClick={onCancel}>
            No
          </s-button>
          <s-button variant="primary" tone="critical" onClick={onConfirm}>
            Yes
          </s-button>
        </div>
      </div>
    </div>
  );
}

export const headers = (headersArgs: Parameters<typeof boundary.headers>[0]) => {
  return boundary.headers(headersArgs);
};
