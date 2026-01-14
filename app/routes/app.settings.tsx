import { useEffect, useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getShopSettings, updateShopSettings } from "../models/shopSettings.server";
import type { ShopSettings, SelectionMode, LayoutType, ImageSize } from "@prisma/client";

interface LoaderData {
  settings: ShopSettings;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getShopSettings(session.shop);
  return { settings };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const defaultSelectionMode = formData.get("defaultSelectionMode") as SelectionMode;
  const defaultLayoutType = formData.get("defaultLayoutType") as LayoutType;
  const defaultImageSize = formData.get("defaultImageSize") as ImageSize;
  const defaultBackgroundColor = formData.get("defaultBackgroundColor") as string;
  const defaultFontColor = formData.get("defaultFontColor") as string;
  const defaultButtonColor = formData.get("defaultButtonColor") as string;
  const defaultButtonTextColor = formData.get("defaultButtonTextColor") as string;
  const analyticsEnabled = formData.get("analyticsEnabled") === "true";

  await updateShopSettings(shop, {
    defaultSelectionMode,
    defaultLayoutType,
    defaultImageSize,
    defaultBackgroundColor,
    defaultFontColor,
    defaultButtonColor,
    defaultButtonTextColor,
    analyticsEnabled,
  });

  return { success: true };
};

export default function Settings() {
  const { settings } = useLoaderData<LoaderData>();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [form, setForm] = useState({
    defaultSelectionMode: settings.defaultSelectionMode,
    defaultLayoutType: settings.defaultLayoutType,
    defaultImageSize: settings.defaultImageSize,
    defaultBackgroundColor: settings.defaultBackgroundColor,
    defaultFontColor: settings.defaultFontColor,
    defaultButtonColor: settings.defaultButtonColor,
    defaultButtonTextColor: settings.defaultButtonTextColor,
    analyticsEnabled: settings.analyticsEnabled,
  });

  const isSubmitting = fetcher.state === "submitting";

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Settings saved");
    }
  }, [fetcher.data, shopify]);

  const handleChange = (field: string, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = () => {
    fetcher.submit(
      {
        ...form,
        analyticsEnabled: String(form.analyticsEnabled),
      },
      { method: "POST" }
    );
  };

  return (
    <s-page heading="Settings">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={handleSubmit}
        {...(isSubmitting ? { loading: true } : {})}
      >
        Save settings
      </s-button>

      <s-section heading="Default bundle settings">
        <s-stack direction="block" gap="base">
          <s-text color="subdued">
            These defaults will be applied when creating new bundles
          </s-text>

          <s-select
            label="Default selection mode"
            value={form.defaultSelectionMode}
            onChange={(e: CustomEvent) => handleChange("defaultSelectionMode", (e.target as HTMLSelectElement).value)}
          >
            <option value="MULTIPLE">Multiple (checkboxes)</option>
            <option value="SINGLE">Single (radio buttons)</option>
          </s-select>

          <s-select
            label="Default layout"
            value={form.defaultLayoutType}
            onChange={(e: CustomEvent) => handleChange("defaultLayoutType", (e.target as HTMLSelectElement).value)}
          >
            <option value="LIST">List</option>
            <option value="GRID">Grid</option>
          </s-select>

          <s-select
            label="Default image size"
            value={form.defaultImageSize}
            onChange={(e: CustomEvent) => handleChange("defaultImageSize", (e.target as HTMLSelectElement).value)}
          >
            <option value="SMALL">Small</option>
            <option value="MEDIUM">Medium</option>
            <option value="LARGE">Large</option>
          </s-select>
        </s-stack>
      </s-section>

      <s-section heading="Default colors">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <s-text-field
              type="color"
              label="Background color"
              value={form.defaultBackgroundColor}
              onInput={(e: CustomEvent) => handleChange("defaultBackgroundColor", (e.target as HTMLInputElement).value)}
            />
            <s-text-field
              type="color"
              label="Font color"
              value={form.defaultFontColor}
              onInput={(e: CustomEvent) => handleChange("defaultFontColor", (e.target as HTMLInputElement).value)}
            />
          </s-stack>
          <s-stack direction="inline" gap="base">
            <s-text-field
              type="color"
              label="Button color"
              value={form.defaultButtonColor}
              onInput={(e: CustomEvent) => handleChange("defaultButtonColor", (e.target as HTMLInputElement).value)}
            />
            <s-text-field
              type="color"
              label="Button text color"
              value={form.defaultButtonTextColor}
              onInput={(e: CustomEvent) => handleChange("defaultButtonTextColor", (e.target as HTMLInputElement).value)}
            />
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Analytics">
        <s-checkbox
          checked={form.analyticsEnabled}
          onChange={(e: CustomEvent) => handleChange("analyticsEnabled", (e.target as HTMLInputElement).checked)}
        >
          Enable analytics tracking
        </s-checkbox>
        <s-text color="subdued">
          Track bundle views, selections, and conversions
        </s-text>
      </s-section>

      <s-section slot="aside" heading="About settings">
        <s-text>
          Configure default values for new bundles and global app behavior.
        </s-text>
        <s-text>
          Individual bundles can override these defaults in their specific settings.
        </s-text>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs: Parameters<typeof boundary.headers>[0]) => {
  return boundary.headers(headersArgs);
};
