import { useEffect, useState, useRef, useCallback } from "react";
import { useFetcher, useNavigate, redirect } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { createBundle, bundleTitleExists, getBundle } from "../models/bundle.server";
import { getOrCreateWidgetStyle } from "../models/widgetStyle.server";
import { buildWidgetConfig, syncShopMetafields } from "../services/metafield.sync";
import { activateBundleDiscount } from "../services/discount.sync";
import type { BundleStatus, SelectionMode, TargetingType, DiscountCombination } from "@prisma/client";

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

    // If bundle is created as ACTIVE, sync metafields and create discount
    let discountError: string | null = null;

    if (status === "ACTIVE") {
      console.log("[createBundle] Bundle created as ACTIVE, syncing metafields and creating discount");

      try {
        // Get the full bundle with relations
        const fullBundle = await getBundle(bundle.id, shop);
        if (fullBundle) {
          // Create widget style if not exists
          const widgetStyle = await getOrCreateWidgetStyle(bundle.id);

          // Build and sync widget config to shop metafield
          const widgetConfig = buildWidgetConfig(fullBundle, [], widgetStyle);

          // Get shop GID
          const shopResponse = await admin.graphql(`query { shop { id } }`);
          const shopResult = await shopResponse.json();
          const shopGid = (shopResult.data?.shop as { id?: string })?.id;

          if (shopGid && targetingType === "ALL_PRODUCTS") {
            console.log("[createBundle] Syncing to shop metafield");
            await syncShopMetafields(admin, shopGid, widgetConfig);
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
    // Store discount error in URL params if needed
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
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const submitButtonRef = useRef<HTMLElement>(null);

  const [form, setForm] = useState<FormState>(defaultFormState);

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

  const handleSubmit = useCallback(() => {
    console.log("handleSubmit called, form:", form);
    const formData = new FormData();
    Object.entries(form).forEach(([key, value]) => {
      formData.append(key, value);
    });
    console.log("Submitting formData entries:", Object.fromEntries(formData));
    fetcher.submit(formData, { method: "POST" });
  }, [form, fetcher]);

  // Attach click handler to web component using native event listener
  useEffect(() => {
    const button = submitButtonRef.current;
    if (button) {
      button.addEventListener("click", handleSubmit);
      return () => {
        button.removeEventListener("click", handleSubmit);
      };
    }
  }, [handleSubmit]);

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

          <s-stack direction="inline" gap="base">
            <div style={{ flex: 1 }}>
              <label style={{ display: "block", marginBottom: "4px", fontWeight: 500 }}>Start date (optional)</label>
              <input
                type="date"
                value={form.startDate}
                onChange={(e) => handleChange("startDate", e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  borderRadius: "8px",
                  border: "1px solid #8c9196",
                  fontSize: "14px",
                  backgroundColor: "#fff",
                }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: "block", marginBottom: "4px", fontWeight: 500 }}>End date (optional)</label>
              <input
                type="date"
                value={form.endDate}
                onChange={(e) => handleChange("endDate", e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  borderRadius: "8px",
                  border: errors.endDate ? "1px solid #d72c0d" : "1px solid #8c9196",
                  fontSize: "14px",
                  backgroundColor: "#fff",
                }}
              />
              {errors.endDate && (
                <span style={{ color: "#d72c0d", fontSize: "12px", marginTop: "4px", display: "block" }}>
                  {errors.endDate}
                </span>
              )}
            </div>
          </s-stack>
        </s-stack>
      </s-section>

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
          <s-text color="subdued">
            {form.targetingType === "ALL_PRODUCTS" && "Add-ons will appear on all product pages."}
            {form.targetingType === "SPECIFIC_PRODUCTS" && "You can select products after creating the bundle."}
            {form.targetingType === "PRODUCT_GROUPS" && "Create groups that display as tabs in the widget."}
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading="Discount combinations">
        <s-stack direction="block" gap="base">
          <div>
            <label style={{ display: "block", marginBottom: "4px", fontWeight: 500 }}>With product discounts</label>
            <select
              value={form.combineWithProductDiscounts}
              onChange={(e) => handleChange("combineWithProductDiscounts", e.target.value)}
              style={{
                width: "100%",
                padding: "8px 12px",
                borderRadius: "8px",
                border: "1px solid #8c9196",
                fontSize: "14px",
                backgroundColor: "#fff",
              }}
            >
              <option value="COMBINE">Combine</option>
              <option value="NOT_COMBINE">Do not combine</option>
            </select>
          </div>
          <div>
            <label style={{ display: "block", marginBottom: "4px", fontWeight: 500 }}>With order discounts</label>
            <select
              value={form.combineWithOrderDiscounts}
              onChange={(e) => handleChange("combineWithOrderDiscounts", e.target.value)}
              style={{
                width: "100%",
                padding: "8px 12px",
                borderRadius: "8px",
                border: "1px solid #8c9196",
                fontSize: "14px",
                backgroundColor: "#fff",
              }}
            >
              <option value="COMBINE">Combine</option>
              <option value="NOT_COMBINE">Do not combine</option>
            </select>
          </div>
          <div>
            <label style={{ display: "block", marginBottom: "4px", fontWeight: 500 }}>With shipping discounts</label>
            <select
              value={form.combineWithShippingDiscounts}
              onChange={(e) => handleChange("combineWithShippingDiscounts", e.target.value)}
              style={{
                width: "100%",
                padding: "8px 12px",
                borderRadius: "8px",
                border: "1px solid #8c9196",
                fontSize: "14px",
                backgroundColor: "#fff",
              }}
            >
              <option value="COMBINE">Combine</option>
              <option value="NOT_COMBINE">Do not combine</option>
            </select>
          </div>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="About bundles">
        <s-stack direction="block" gap="base">
          <s-text>
            Add-on bundles let you offer additional products when customers add items to their cart.
          </s-text>
          <s-text>
            After creating the bundle, you'll be able to add products as add-ons and configure discounts.
          </s-text>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs: Parameters<typeof boundary.headers>[0]) => {
  return boundary.headers(headersArgs);
};
