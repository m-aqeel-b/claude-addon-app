import { useEffect, useState } from "react";
import { useLoaderData, useFetcher, useNavigate, useParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getBundle, updateBundle, deleteBundle, bundleTitleExists } from "../models/bundle.server";
import { getAddOnSets, createAddOnSet, updateAddOnSet, deleteAddOnSet } from "../models/addOnSet.server";
import { updateWidgetStyle, resetWidgetStyle, getOrCreateWidgetStyle } from "../models/widgetStyle.server";
import type { BundleWithRelations } from "../models/bundle.server";
import type { AddOnSetWithVariants } from "../models/addOnSet.server";
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
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const bundleId = params.id!;

  const bundle = await getBundle(bundleId, shop);
  if (!bundle) {
    throw new Response("Bundle not found", { status: 404 });
  }

  const [addOnSets, widgetStyle] = await Promise.all([
    getAddOnSets(bundleId),
    getOrCreateWidgetStyle(bundleId),
  ]);

  return { bundle, addOnSets, widgetStyle };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
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

    return { success: true, action: "bundleUpdated" };
  }

  // Delete bundle
  if (intent === "deleteBundle") {
    await deleteBundle(bundleId, shop);
    return { success: true, action: "bundleDeleted", redirect: "/app/bundles" };
  }

  // Add-on set operations
  if (intent === "createAddOnSet") {
    const shopifyProductId = formData.get("shopifyProductId") as string;
    const productTitle = formData.get("productTitle") as string;

    await createAddOnSet({
      bundleId,
      shopifyProductId,
      productTitle,
    });

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

    return { success: true, action: "addOnUpdated" };
  }

  if (intent === "deleteAddOnSet") {
    const addOnSetId = formData.get("addOnSetId") as string;
    await deleteAddOnSet(addOnSetId);
    return { success: true, action: "addOnDeleted" };
  }

  // Widget style operations
  if (intent === "updateStyle") {
    const styleData = JSON.parse(formData.get("styleData") as string);
    await updateWidgetStyle(bundleId, styleData);
    return { success: true, action: "styleUpdated" };
  }

  if (intent === "resetStyle") {
    await resetWidgetStyle(bundleId);
    return { success: true, action: "styleReset" };
  }

  return { success: false };
};

function formatDateTimeLocal(date: Date | string | null): string {
  if (!date) return "";
  const d = new Date(date);
  return d.toISOString().slice(0, 16);
}

export default function EditBundle() {
  const { bundle, addOnSets, widgetStyle } = useLoaderData<LoaderData>();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const params = useParams();

  const [activeTab, setActiveTab] = useState<TabType>("general");
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
      shopify.toast.show("Bundle saved");
    } else if (fetcher.data?.action === "bundleDeleted") {
      shopify.toast.show("Bundle deleted");
      navigate("/app/bundles");
    } else if (fetcher.data?.action === "addOnCreated") {
      shopify.toast.show("Add-on added");
    } else if (fetcher.data?.action === "addOnUpdated") {
      shopify.toast.show("Add-on updated");
    } else if (fetcher.data?.action === "addOnDeleted") {
      shopify.toast.show("Add-on removed");
    } else if (fetcher.data?.action === "styleUpdated") {
      shopify.toast.show("Styles saved");
    } else if (fetcher.data?.action === "styleReset") {
      shopify.toast.show("Styles reset to defaults");
    }
  }, [fetcher.data, shopify, navigate]);

  const handleFormChange = (field: string, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleStyleChange = (field: string, value: string | number) => {
    setStyle((prev) => ({ ...prev, [field]: value }));
  };

  const handleSaveBundle = () => {
    fetcher.submit({ intent: "updateBundle", ...form }, { method: "POST" });
  };

  const handleDeleteBundle = () => {
    if (confirm(`Are you sure you want to delete "${bundle.title}"? This cannot be undone.`)) {
      fetcher.submit({ intent: "deleteBundle" }, { method: "POST" });
    }
  };

  const handleSaveStyles = () => {
    fetcher.submit(
      { intent: "updateStyle", styleData: JSON.stringify(style) },
      { method: "POST" }
    );
  };

  const handleResetStyles = () => {
    if (confirm("Reset all styles to defaults?")) {
      fetcher.submit({ intent: "resetStyle" }, { method: "POST" });
    }
  };

  const handleDeleteAddOn = (addOnSetId: string, title: string) => {
    if (confirm(`Remove "${title}" from this bundle?`)) {
      fetcher.submit({ intent: "deleteAddOnSet", addOnSetId }, { method: "POST" });
    }
  };

  const openProductPicker = async () => {
    const selected = await shopify.resourcePicker({ type: "product", multiple: false });
    if (selected && selected.length > 0) {
      const product = selected[0];
      fetcher.submit(
        {
          intent: "createAddOnSet",
          shopifyProductId: product.id,
          productTitle: product.title,
        },
        { method: "POST" }
      );
    }
  };

  return (
    <s-page
      heading={bundle.title}
      backAction={{ content: "Bundles", onAction: () => navigate("/app/bundles") }}
    >
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={activeTab === "styles" ? handleSaveStyles : handleSaveBundle}
        {...(isSubmitting ? { loading: true } : {})}
      >
        Save
      </s-button>
      <s-button
        slot="secondary-action"
        variant="tertiary"
        tone="critical"
        onClick={handleDeleteBundle}
      >
        Delete
      </s-button>

      {/* Tab Navigation */}
      <s-section>
        <s-stack direction="inline" gap="tight">
          <s-button
            variant={activeTab === "general" ? "primary" : "secondary"}
            onClick={() => setActiveTab("general")}
          >
            General
          </s-button>
          <s-button
            variant={activeTab === "addons" ? "primary" : "secondary"}
            onClick={() => setActiveTab("addons")}
          >
            Add-ons ({addOnSets.length})
          </s-button>
          <s-button
            variant={activeTab === "styles" ? "primary" : "secondary"}
            onClick={() => setActiveTab("styles")}
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
                onInput={(e: CustomEvent) => handleFormChange("title", (e.target as HTMLInputElement).value)}
                error={errors.title}
                required
              />
              <s-text-field
                label="Subtitle"
                value={form.subtitle}
                onInput={(e: CustomEvent) => handleFormChange("subtitle", (e.target as HTMLInputElement).value)}
              />
            </s-stack>
          </s-section>

          <s-section heading="Status & Schedule">
            <s-stack direction="block" gap="base">
              <s-select
                label="Status"
                value={form.status}
                onChange={(e: CustomEvent) => handleFormChange("status", (e.target as HTMLSelectElement).value)}
              >
                <option value="DRAFT">Draft</option>
                <option value="ACTIVE">Active</option>
                <option value="ARCHIVED">Archived</option>
              </s-select>

              <s-stack direction="inline" gap="base">
                <s-text-field
                  type="datetime-local"
                  label="Start date"
                  value={form.startDate}
                  onInput={(e: CustomEvent) => handleFormChange("startDate", (e.target as HTMLInputElement).value)}
                />
                <s-text-field
                  type="datetime-local"
                  label="End date"
                  value={form.endDate}
                  onInput={(e: CustomEvent) => handleFormChange("endDate", (e.target as HTMLInputElement).value)}
                  error={errors.endDate}
                />
              </s-stack>
            </s-stack>
          </s-section>

          <s-section heading="Selection mode">
            <s-radio-group
              legend="How can customers select add-ons?"
              value={form.selectionMode}
              onChange={(e: CustomEvent) => handleFormChange("selectionMode", (e.target as HTMLInputElement).value)}
            >
              <s-radio value="MULTIPLE">Multiple selection (checkboxes)</s-radio>
              <s-radio value="SINGLE">Single selection (radio buttons)</s-radio>
            </s-radio-group>
          </s-section>

          <s-section heading="Product targeting">
            <s-radio-group
              legend="Which products show this bundle?"
              value={form.targetingType}
              onChange={(e: CustomEvent) => handleFormChange("targetingType", (e.target as HTMLInputElement).value)}
            >
              <s-radio value="ALL_PRODUCTS">All products</s-radio>
              <s-radio value="SPECIFIC_PRODUCTS">Specific products or collections</s-radio>
              <s-radio value="PRODUCT_GROUPS">Product groups (with tabs)</s-radio>
            </s-radio-group>
          </s-section>

          <s-section heading="Discount combinations">
            <s-stack direction="block" gap="base">
              <s-select
                label="With product discounts"
                value={form.combineWithProductDiscounts}
                onChange={(e: CustomEvent) => handleFormChange("combineWithProductDiscounts", (e.target as HTMLSelectElement).value)}
              >
                <option value="COMBINE">Combine</option>
                <option value="NOT_COMBINE">Do not combine</option>
              </s-select>
              <s-select
                label="With order discounts"
                value={form.combineWithOrderDiscounts}
                onChange={(e: CustomEvent) => handleFormChange("combineWithOrderDiscounts", (e.target as HTMLSelectElement).value)}
              >
                <option value="COMBINE">Combine</option>
                <option value="NOT_COMBINE">Do not combine</option>
              </s-select>
              <s-select
                label="With shipping discounts"
                value={form.combineWithShippingDiscounts}
                onChange={(e: CustomEvent) => handleFormChange("combineWithShippingDiscounts", (e.target as HTMLSelectElement).value)}
              >
                <option value="COMBINE">Combine</option>
                <option value="NOT_COMBINE">Do not combine</option>
              </s-select>
            </s-stack>
          </s-section>
        </>
      )}

      {/* Add-ons Tab */}
      {activeTab === "addons" && (
        <>
          <s-section heading="Add-on products">
            <s-stack direction="block" gap="base">
              <s-button variant="secondary" onClick={openProductPicker}>
                Add product
              </s-button>

              {addOnSets.length === 0 ? (
                <s-box padding="extraLarge" textAlign="center">
                  <s-stack direction="block" gap="base" align="center">
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
                  onInput={(e: CustomEvent) => handleStyleChange("backgroundColor", (e.target as HTMLInputElement).value)}
                />
                <s-text-field
                  type="color"
                  label="Font"
                  value={style.fontColor}
                  onInput={(e: CustomEvent) => handleStyleChange("fontColor", (e.target as HTMLInputElement).value)}
                />
              </s-stack>
              <s-stack direction="inline" gap="base">
                <s-text-field
                  type="color"
                  label="Button"
                  value={style.buttonColor}
                  onInput={(e: CustomEvent) => handleStyleChange("buttonColor", (e.target as HTMLInputElement).value)}
                />
                <s-text-field
                  type="color"
                  label="Button text"
                  value={style.buttonTextColor}
                  onInput={(e: CustomEvent) => handleStyleChange("buttonTextColor", (e.target as HTMLInputElement).value)}
                />
              </s-stack>
              <s-stack direction="inline" gap="base">
                <s-text-field
                  type="color"
                  label="Discount badge"
                  value={style.discountBadgeColor}
                  onInput={(e: CustomEvent) => handleStyleChange("discountBadgeColor", (e.target as HTMLInputElement).value)}
                />
                <s-text-field
                  type="color"
                  label="Discount text"
                  value={style.discountTextColor}
                  onInput={(e: CustomEvent) => handleStyleChange("discountTextColor", (e.target as HTMLInputElement).value)}
                />
              </s-stack>
              <s-text-field
                type="color"
                label="Border color"
                value={style.borderColor}
                onInput={(e: CustomEvent) => handleStyleChange("borderColor", (e.target as HTMLInputElement).value)}
              />
            </s-stack>
          </s-section>

          <s-section heading="Layout">
            <s-stack direction="block" gap="base">
              <s-select
                label="Layout type"
                value={style.layoutType}
                onChange={(e: CustomEvent) => handleStyleChange("layoutType", (e.target as HTMLSelectElement).value)}
              >
                <option value="LIST">List</option>
                <option value="GRID">Grid</option>
              </s-select>
              <s-select
                label="Image size"
                value={style.imageSize}
                onChange={(e: CustomEvent) => handleStyleChange("imageSize", (e.target as HTMLSelectElement).value)}
              >
                <option value="SMALL">Small</option>
                <option value="MEDIUM">Medium</option>
                <option value="LARGE">Large</option>
              </s-select>
              <s-select
                label="Discount label style"
                value={style.discountLabelStyle}
                onChange={(e: CustomEvent) => handleStyleChange("discountLabelStyle", (e.target as HTMLSelectElement).value)}
              >
                <option value="BADGE">Badge</option>
                <option value="HIGHLIGHTED_TEXT">Highlighted text</option>
              </s-select>
            </s-stack>
          </s-section>

          <s-section heading="Typography">
            <s-stack direction="block" gap="base">
              <s-text-field
                type="number"
                label="Title font size (px)"
                value={String(style.titleFontSize)}
                onInput={(e: CustomEvent) => handleStyleChange("titleFontSize", parseInt((e.target as HTMLInputElement).value))}
                min="10"
                max="32"
              />
              <s-text-field
                type="number"
                label="Subtitle font size (px)"
                value={String(style.subtitleFontSize)}
                onInput={(e: CustomEvent) => handleStyleChange("subtitleFontSize", parseInt((e.target as HTMLInputElement).value))}
                min="10"
                max="24"
              />
              <s-text-field
                type="number"
                label="Body font size (px)"
                value={String(style.fontSize)}
                onInput={(e: CustomEvent) => handleStyleChange("fontSize", parseInt((e.target as HTMLInputElement).value))}
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
                onInput={(e: CustomEvent) => handleStyleChange("borderRadius", parseInt((e.target as HTMLInputElement).value))}
                min="0"
                max="24"
              />
              <s-select
                label="Border style"
                value={style.borderStyle}
                onChange={(e: CustomEvent) => handleStyleChange("borderStyle", (e.target as HTMLSelectElement).value)}
              >
                <option value="NONE">None</option>
                <option value="SOLID">Solid</option>
                <option value="DASHED">Dashed</option>
                <option value="DOTTED">Dotted</option>
              </s-select>
              <s-text-field
                type="number"
                label="Border width (px)"
                value={String(style.borderWidth)}
                onInput={(e: CustomEvent) => handleStyleChange("borderWidth", parseInt((e.target as HTMLInputElement).value))}
                min="0"
                max="5"
              />
              <s-text-field
                type="number"
                label="Padding (px)"
                value={String(style.padding)}
                onInput={(e: CustomEvent) => handleStyleChange("padding", parseInt((e.target as HTMLInputElement).value))}
                min="0"
                max="48"
              />
              <s-stack direction="inline" gap="base">
                <s-text-field
                  type="number"
                  label="Margin top (px)"
                  value={String(style.marginTop)}
                  onInput={(e: CustomEvent) => handleStyleChange("marginTop", parseInt((e.target as HTMLInputElement).value))}
                  min="0"
                  max="64"
                />
                <s-text-field
                  type="number"
                  label="Margin bottom (px)"
                  value={String(style.marginBottom)}
                  onInput={(e: CustomEvent) => handleStyleChange("marginBottom", parseInt((e.target as HTMLInputElement).value))}
                  min="0"
                  max="64"
                />
              </s-stack>
            </s-stack>
          </s-section>

          <s-section>
            <s-button variant="tertiary" onClick={handleResetStyles}>
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
}

function AddOnSetCard({ addOn, onDelete, onUpdate }: AddOnSetCardProps) {
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

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base" align="center">
          <s-stack direction="block" gap="tight" style={{ flex: 1 }}>
            <s-text variant="headingSm">{addOn.productTitle || "Untitled product"}</s-text>
            <s-text variant="bodySm" color="subdued">
              {discountType === "FREE_GIFT" ? "Free gift" : `${discountType.replace(/_/g, " ")}${discountValue ? `: ${discountValue}` : ""}`}
            </s-text>
          </s-stack>
          <s-button variant="tertiary" onClick={() => setIsExpanded(!isExpanded)}>
            {isExpanded ? "Collapse" : "Configure"}
          </s-button>
          <s-button variant="tertiary" tone="critical" onClick={onDelete}>
            Remove
          </s-button>
        </s-stack>

        {isExpanded && (
          <s-stack direction="block" gap="base">
            <s-select
              label="Discount type"
              value={discountType}
              onChange={(e: CustomEvent) => setDiscountType((e.target as HTMLSelectElement).value as DiscountType)}
            >
              <option value="PERCENTAGE">Percentage</option>
              <option value="FIXED_AMOUNT">Fixed amount off</option>
              <option value="FIXED_PRICE">Fixed price</option>
              <option value="FREE_GIFT">Free gift (100% off)</option>
            </s-select>

            {discountType !== "FREE_GIFT" && (
              <s-text-field
                type="number"
                label={discountType === "PERCENTAGE" ? "Discount percentage" : "Discount amount"}
                value={discountValue}
                onInput={(e: CustomEvent) => setDiscountValue((e.target as HTMLInputElement).value)}
                min="0"
                step={discountType === "PERCENTAGE" ? "1" : "0.01"}
              />
            )}

            <s-text-field
              label="Discount label (optional)"
              value={discountLabel}
              onInput={(e: CustomEvent) => setDiscountLabel((e.target as HTMLInputElement).value)}
              placeholder="e.g., Save 20%"
            />

            <s-checkbox
              checked={isDefaultSelected}
              onChange={(e: CustomEvent) => setIsDefaultSelected((e.target as HTMLInputElement).checked)}
              disabled={discountType === "FREE_GIFT"}
            >
              Pre-selected by default
            </s-checkbox>

            <s-checkbox
              checked={subscriptionOnly}
              onChange={(e: CustomEvent) => setSubscriptionOnly((e.target as HTMLInputElement).checked)}
            >
              Subscription orders only
            </s-checkbox>

            <s-checkbox
              checked={showQuantitySelector}
              onChange={(e: CustomEvent) => setShowQuantitySelector((e.target as HTMLInputElement).checked)}
            >
              Show quantity selector
            </s-checkbox>

            {showQuantitySelector && (
              <s-text-field
                type="number"
                label="Maximum quantity"
                value={String(maxQuantity)}
                onInput={(e: CustomEvent) => setMaxQuantity(parseInt((e.target as HTMLInputElement).value))}
                min="1"
                max="99"
              />
            )}

            <s-button variant="secondary" onClick={handleSave}>
              Save add-on settings
            </s-button>
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
