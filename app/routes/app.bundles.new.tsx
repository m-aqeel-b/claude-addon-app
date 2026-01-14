import { useEffect, useState } from "react";
import { useLoaderData, useFetcher, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { createBundle, bundleTitleExists } from "../models/bundle.server";
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
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
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

  return { success: true, bundleId: bundle.id };
};

export default function NewBundle() {
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const shopify = useAppBridge();

  const [form, setForm] = useState<FormState>(defaultFormState);

  const isSubmitting = fetcher.state === "submitting";
  const errors = fetcher.data?.errors || {};

  useEffect(() => {
    if (fetcher.data?.success && fetcher.data?.bundleId) {
      shopify.toast.show("Bundle created successfully");
      navigate(`/app/bundles/${fetcher.data.bundleId}`);
    }
  }, [fetcher.data, shopify, navigate]);

  const handleChange = (field: keyof FormState, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = () => {
    fetcher.submit(form, { method: "POST" });
  };

  return (
    <s-page
      heading="Create bundle"
      backAction={{ content: "Bundles", onAction: () => navigate("/app/bundles") }}
    >
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={handleSubmit}
        {...(isSubmitting ? { loading: true } : {})}
      >
        Create bundle
      </s-button>

      <s-section heading="Basic information">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Title"
            value={form.title}
            onInput={(e: CustomEvent) => handleChange("title", (e.target as HTMLInputElement).value)}
            error={errors.title}
            required
            placeholder="e.g., Holiday Add-Ons"
          />
          <s-text-field
            label="Subtitle"
            value={form.subtitle}
            onInput={(e: CustomEvent) => handleChange("subtitle", (e.target as HTMLInputElement).value)}
            placeholder="Optional description shown to customers"
          />
        </s-stack>
      </s-section>

      <s-section heading="Status & Schedule">
        <s-stack direction="block" gap="base">
          <s-select
            label="Status"
            value={form.status}
            onChange={(e: CustomEvent) => handleChange("status", (e.target as HTMLSelectElement).value)}
          >
            <option value="DRAFT">Draft</option>
            <option value="ACTIVE">Active</option>
          </s-select>

          <s-stack direction="inline" gap="base">
            <s-text-field
              type="datetime-local"
              label="Start date (optional)"
              value={form.startDate}
              onInput={(e: CustomEvent) => handleChange("startDate", (e.target as HTMLInputElement).value)}
            />
            <s-text-field
              type="datetime-local"
              label="End date (optional)"
              value={form.endDate}
              onInput={(e: CustomEvent) => handleChange("endDate", (e.target as HTMLInputElement).value)}
              error={errors.endDate}
            />
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Customer selection">
        <s-stack direction="block" gap="base">
          <s-radio-group
            legend="Selection mode"
            value={form.selectionMode}
            onChange={(e: CustomEvent) => handleChange("selectionMode", (e.target as HTMLInputElement).value)}
          >
            <s-radio value="MULTIPLE">Multiple - Customers can select multiple add-ons</s-radio>
            <s-radio value="SINGLE">Single - Customers can select only one add-on</s-radio>
          </s-radio-group>
        </s-stack>
      </s-section>

      <s-section heading="Product targeting">
        <s-stack direction="block" gap="base">
          <s-radio-group
            legend="Which products should show this bundle?"
            value={form.targetingType}
            onChange={(e: CustomEvent) => handleChange("targetingType", (e.target as HTMLInputElement).value)}
          >
            <s-radio value="ALL_PRODUCTS">All products</s-radio>
            <s-radio value="SPECIFIC_PRODUCTS">Specific products or collections</s-radio>
            <s-radio value="PRODUCT_GROUPS">Product groups (with tabs)</s-radio>
          </s-radio-group>
          <s-text color="subdued">
            {form.targetingType === "ALL_PRODUCTS" && "Add-ons will appear on all product pages."}
            {form.targetingType === "SPECIFIC_PRODUCTS" && "You can select products after creating the bundle."}
            {form.targetingType === "PRODUCT_GROUPS" && "Create groups that display as tabs in the widget."}
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading="Discount combinations">
        <s-stack direction="block" gap="base">
          <s-select
            label="With product discounts"
            value={form.combineWithProductDiscounts}
            onChange={(e: CustomEvent) => handleChange("combineWithProductDiscounts", (e.target as HTMLSelectElement).value)}
          >
            <option value="COMBINE">Combine</option>
            <option value="NOT_COMBINE">Do not combine</option>
          </s-select>
          <s-select
            label="With order discounts"
            value={form.combineWithOrderDiscounts}
            onChange={(e: CustomEvent) => handleChange("combineWithOrderDiscounts", (e.target as HTMLSelectElement).value)}
          >
            <option value="COMBINE">Combine</option>
            <option value="NOT_COMBINE">Do not combine</option>
          </s-select>
          <s-select
            label="With shipping discounts"
            value={form.combineWithShippingDiscounts}
            onChange={(e: CustomEvent) => handleChange("combineWithShippingDiscounts", (e.target as HTMLSelectElement).value)}
          >
            <option value="COMBINE">Combine</option>
            <option value="NOT_COMBINE">Do not combine</option>
          </s-select>
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
