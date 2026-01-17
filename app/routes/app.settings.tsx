import { useEffect, useState, useRef, useCallback } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getShopSettings, updateShopSettings } from "../models/shopSettings.server";
import type { ShopSettings, SelectionMode, LayoutType, ImageSize } from "@prisma/client";

interface MetafieldInfo {
  id: string;
  namespace: string;
  key: string;
  value: string;
}

interface LoaderData {
  settings: ShopSettings;
  shopMetafields: MetafieldInfo[];
  productMetafieldCount: number;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const settings = await getShopSettings(session.shop);

  // Fetch ALL shop metafields to debug namespace issues
  let shopMetafields: MetafieldInfo[] = [];
  let allMetafieldsCount = 0;
  let productMetafieldCount = 0;
  try {
    const response = await admin.graphql(
      `#graphql
      query GetShopMetafields {
        shop {
          metafields(first: 100) {
            nodes {
              id
              namespace
              key
              value
            }
          }
        }
      }`
    );
    const result = await response.json();
    const allMetafields = (result.data?.shop as { metafields?: { nodes?: MetafieldInfo[] } })?.metafields?.nodes || [];
    allMetafieldsCount = allMetafields.length;
    console.log("[Settings] All metafields found:", allMetafields.map(m => `${m.namespace}:${m.key}`));
    // Show ALL metafields for debugging, not just addon-bundle
    shopMetafields = allMetafields;

    // Also check for products with addon-bundle metafields
    const productResponse = await admin.graphql(
      `#graphql
      query GetProductsWithMetafields {
        products(first: 50, query: "metafields.namespace:addon-bundle") {
          nodes {
            id
            title
            metafield(namespace: "addon-bundle", key: "config") {
              id
              value
            }
          }
        }
      }`
    );
    const productResult = await productResponse.json();
    const productsWithMetafields = (productResult.data as { products?: { nodes?: Array<{ id: string; title: string; metafield?: { id: string; value: string } }> } })?.products?.nodes || [];
    productMetafieldCount = productsWithMetafields.filter(p => p.metafield).length;
    console.log("[Settings] Products with addon-bundle metafields:", productMetafieldCount);
  } catch (error) {
    console.error("[Settings] Error fetching metafields:", error);
  }

  return { settings, shopMetafields, productMetafieldCount };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Handle clear metafield action
  if (intent === "clearMetafield") {
    const metafieldNamespace = formData.get("metafieldNamespace") as string;
    const metafieldKey = formData.get("metafieldKey") as string;
    console.log("[Settings] Clearing metafield:", metafieldNamespace, metafieldKey);

    try {
      // Get shop GID first
      const shopResponse = await admin.graphql(`query { shop { id } }`);
      const shopResult = await shopResponse.json();
      const shopGid = (shopResult.data?.shop as { id?: string })?.id;

      if (!shopGid) {
        return { success: false, error: "Could not get shop ID" };
      }

      const response = await admin.graphql(
        `#graphql
        mutation MetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) {
            deletedMetafields {
              ownerId
              namespace
              key
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            metafields: [{
              ownerId: shopGid,
              namespace: metafieldNamespace,
              key: metafieldKey,
            }],
          },
        }
      );

      const result = await response.json();
      console.log("[Settings] Delete result:", JSON.stringify(result, null, 2));

      const deleteData = result.data as {
        metafieldsDelete?: {
          deletedMetafields?: Array<{ ownerId: string; namespace: string; key: string }>;
          userErrors?: Array<{ field: string; message: string }>;
        };
      };

      if (deleteData?.metafieldsDelete?.userErrors?.length) {
        return {
          success: false,
          error: deleteData.metafieldsDelete.userErrors.map(e => e.message).join(", "),
        };
      }

      return { success: true, action: "metafieldCleared" };
    } catch (error) {
      console.error("[Settings] Error clearing metafield:", error);
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  // Handle clear all product metafields action
  if (intent === "clearAllProductMetafields") {
    console.log("[Settings] Clearing all product addon-bundle metafields");

    try {
      // Find all products with addon-bundle metafields
      const productResponse = await admin.graphql(
        `#graphql
        query GetProductsWithMetafields {
          products(first: 100) {
            nodes {
              id
              title
              metafield(namespace: "addon-bundle", key: "config") {
                id
                namespace
                key
              }
            }
          }
        }`
      );
      const productResult = await productResponse.json();
      const products = (productResult.data as { products?: { nodes?: Array<{ id: string; title: string; metafield?: { id: string; namespace: string; key: string } }> } })?.products?.nodes || [];

      const productsWithMetafields = products.filter(p => p.metafield);
      console.log("[Settings] Found", productsWithMetafields.length, "products with metafields");

      if (productsWithMetafields.length === 0) {
        return { success: true, action: "noProductMetafieldsToDelete" };
      }

      // Delete metafields from each product
      const deleteResponse = await admin.graphql(
        `#graphql
        mutation MetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) {
            deletedMetafields {
              ownerId
              namespace
              key
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            metafields: productsWithMetafields.map(p => ({
              ownerId: p.id,
              namespace: "addon-bundle",
              key: "config",
            })),
          },
        }
      );

      const deleteResult = await deleteResponse.json();
      console.log("[Settings] Delete product metafields result:", JSON.stringify(deleteResult, null, 2));

      const deleteData = deleteResult.data as {
        metafieldsDelete?: {
          deletedMetafields?: Array<{ ownerId: string; namespace: string; key: string }>;
          userErrors?: Array<{ field: string; message: string }>;
        };
      };

      if (deleteData?.metafieldsDelete?.userErrors?.length) {
        return {
          success: false,
          error: deleteData.metafieldsDelete.userErrors.map(e => e.message).join(", "),
        };
      }

      return {
        success: true,
        action: "productMetafieldsCleared",
        count: deleteData?.metafieldsDelete?.deletedMetafields?.length || 0,
      };
    } catch (error) {
      console.error("[Settings] Error clearing product metafields:", error);
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  // Handle clear all metafields action
  if (intent === "clearAllMetafields") {
    console.log("[Settings] Clearing all addon-bundle metafields");

    try {
      // Get shop GID first
      const shopResponse = await admin.graphql(`query { shop { id } }`);
      const shopResult = await shopResponse.json();
      const shopGid = (shopResult.data?.shop as { id?: string })?.id;

      if (!shopGid) {
        return { success: false, error: "Could not get shop ID" };
      }

      // Fetch all metafields
      const fetchResponse = await admin.graphql(
        `#graphql
        query GetShopMetafields {
          shop {
            metafields(first: 100) {
              nodes {
                id
                namespace
                key
              }
            }
          }
        }`
      );
      const fetchResult = await fetchResponse.json();
      const allMetafields = (fetchResult.data?.shop as { metafields?: { nodes?: Array<{ id: string; namespace: string; key: string }> } })?.metafields?.nodes || [];

      console.log("[Settings] All metafields:", allMetafields.map(m => `${m.namespace}:${m.key}`));

      // Filter to addon-bundle related metafields - broader match including $app: prefix
      const toDelete = allMetafields.filter(mf =>
        mf.namespace.includes('addon-bundle') ||
        mf.namespace.includes('addon_bundle') ||
        mf.key.includes('addon') ||
        mf.key.includes('bundle') ||
        mf.key === 'global_config' ||
        mf.key === 'config'
      );

      console.log("[Settings] Metafields to delete:", toDelete.map(m => `${m.namespace}:${m.key}`));

      if (toDelete.length === 0) {
        return { success: true, action: "noMetafieldsToDelete" };
      }

      // Delete them using ownerId, namespace, key (NOT id)
      const deleteResponse = await admin.graphql(
        `#graphql
        mutation MetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) {
            deletedMetafields {
              ownerId
              namespace
              key
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            metafields: toDelete.map(mf => ({
              ownerId: shopGid,
              namespace: mf.namespace,
              key: mf.key,
            })),
          },
        }
      );

      const deleteResult = await deleteResponse.json();
      console.log("[Settings] Delete all result:", JSON.stringify(deleteResult, null, 2));

      const deleteData = deleteResult.data as {
        metafieldsDelete?: {
          deletedMetafields?: Array<{ ownerId: string; namespace: string; key: string }>;
          userErrors?: Array<{ field: string; message: string }>;
        };
      };

      if (deleteData?.metafieldsDelete?.userErrors?.length) {
        return {
          success: false,
          error: deleteData.metafieldsDelete.userErrors.map(e => e.message).join(", "),
        };
      }

      return {
        success: true,
        action: "allMetafieldsCleared",
        count: deleteData?.metafieldsDelete?.deletedMetafields?.length || 0,
      };
    } catch (error) {
      console.error("[Settings] Error clearing all metafields:", error);
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  // Default: Update settings
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
  const { settings, shopMetafields, productMetafieldCount } = useLoaderData<LoaderData>();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const clearAllButtonRef = useRef<HTMLElement>(null);
  const clearProductButtonRef = useRef<HTMLElement>(null);

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
      if (fetcher.data.action === "metafieldCleared") {
        shopify.toast.show("Metafield cleared - refresh the page to see updates");
      } else if (fetcher.data.action === "allMetafieldsCleared") {
        shopify.toast.show(`Cleared ${fetcher.data.count} shop metafield(s) - refresh the storefront`);
      } else if (fetcher.data.action === "noMetafieldsToDelete") {
        shopify.toast.show("No shop metafields found to delete");
      } else if (fetcher.data.action === "productMetafieldsCleared") {
        shopify.toast.show(`Cleared ${fetcher.data.count} product metafield(s) - refresh the storefront`);
      } else if (fetcher.data.action === "noProductMetafieldsToDelete") {
        shopify.toast.show("No product metafields found to delete");
      } else {
        shopify.toast.show("Settings saved");
      }
    } else if (fetcher.data?.error) {
      shopify.toast.show(`Error: ${fetcher.data.error}`, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const handleClearMetafield = (namespace: string, key: string) => {
    if (confirm(`Are you sure you want to delete metafield ${namespace}:${key}?`)) {
      fetcher.submit(
        { intent: "clearMetafield", metafieldNamespace: namespace, metafieldKey: key },
        { method: "POST" }
      );
    }
  };

  const handleClearAllMetafields = useCallback(() => {
    if (confirm("Are you sure you want to delete ALL shop metafields? This will remove the widget from all pages.")) {
      fetcher.submit(
        { intent: "clearAllMetafields" },
        { method: "POST" }
      );
    }
  }, [fetcher]);

  const handleClearAllProductMetafields = useCallback(() => {
    if (confirm("Are you sure you want to delete ALL product metafields? This will remove widget config from individual products.")) {
      fetcher.submit(
        { intent: "clearAllProductMetafields" },
        { method: "POST" }
      );
    }
  }, [fetcher]);

  useEffect(() => {
    const btn = clearAllButtonRef.current;
    if (btn) {
      btn.addEventListener("click", handleClearAllMetafields);
      return () => btn.removeEventListener("click", handleClearAllMetafields);
    }
  }, [handleClearAllMetafields]);

  useEffect(() => {
    const btn = clearProductButtonRef.current;
    if (btn) {
      btn.addEventListener("click", handleClearAllProductMetafields);
      return () => btn.removeEventListener("click", handleClearAllProductMetafields);
    }
  }, [handleClearAllProductMetafields]);

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
            onChange={(e: Event) => handleChange("defaultSelectionMode", (e.target as HTMLSelectElement).value)}
          >
            <option value="MULTIPLE">Multiple (checkboxes)</option>
            <option value="SINGLE">Single (radio buttons)</option>
          </s-select>

          <s-select
            label="Default layout"
            value={form.defaultLayoutType}
            onChange={(e: Event) => handleChange("defaultLayoutType", (e.target as HTMLSelectElement).value)}
          >
            <option value="LIST">List</option>
            <option value="GRID">Grid</option>
          </s-select>

          <s-select
            label="Default image size"
            value={form.defaultImageSize}
            onChange={(e: Event) => handleChange("defaultImageSize", (e.target as HTMLSelectElement).value)}
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
              onInput={(e: Event) => handleChange("defaultBackgroundColor", (e.target as HTMLInputElement).value)}
            />
            <s-text-field
              type="color"
              label="Font color"
              value={form.defaultFontColor}
              onInput={(e: Event) => handleChange("defaultFontColor", (e.target as HTMLInputElement).value)}
            />
          </s-stack>
          <s-stack direction="inline" gap="base">
            <s-text-field
              type="color"
              label="Button color"
              value={form.defaultButtonColor}
              onInput={(e: Event) => handleChange("defaultButtonColor", (e.target as HTMLInputElement).value)}
            />
            <s-text-field
              type="color"
              label="Button text color"
              value={form.defaultButtonTextColor}
              onInput={(e: Event) => handleChange("defaultButtonTextColor", (e.target as HTMLInputElement).value)}
            />
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Analytics">
        <s-checkbox
          checked={form.analyticsEnabled}
          onChange={(e: Event) => handleChange("analyticsEnabled", (e.target as HTMLInputElement).checked)}
        >
          Enable analytics tracking
        </s-checkbox>
        <s-text color="subdued">
          Track bundle views, selections, and conversions
        </s-text>
      </s-section>

      <s-section heading="Debug: Shop Metafields">
        <s-stack direction="block" gap="base">
          <s-text color="subdued">
            Showing ALL shop metafields to debug namespace issues. Addon-bundle related ones are highlighted. Total: {shopMetafields.length}
          </s-text>

          <s-stack direction="inline" gap="base">
            <s-button
              ref={clearAllButtonRef}
              variant="tertiary"
              tone="critical"
              {...(isSubmitting ? { loading: true } : {})}
            >
              Clear Shop Metafields
            </s-button>
            <s-button
              ref={clearProductButtonRef}
              variant="tertiary"
              tone="critical"
              {...(isSubmitting ? { loading: true } : {})}
            >
              Clear Product Metafields ({productMetafieldCount})
            </s-button>
          </s-stack>

          <s-box padding="base" background="info" borderRadius="base">
            <s-text>
              <strong>Products with addon-bundle config:</strong> {productMetafieldCount}
              {productMetafieldCount > 0 && " - Click 'Clear Product Metafields' to remove"}
            </s-text>
          </s-box>

          {shopMetafields.length === 0 ? (
            <s-box padding="base" background="subdued" borderRadius="base">
              <s-text color="subdued">No shop metafields found</s-text>
            </s-box>
          ) : (
            <s-stack direction="block" gap="tight">
              {shopMetafields.map((mf) => {
                const isAddonBundle = mf.namespace.includes('addon-bundle') || mf.namespace.includes('addon_bundle');
                return (
                  <s-box
                    key={mf.id}
                    padding="base"
                    borderWidth="base"
                    borderRadius="base"
                    background={isAddonBundle ? "warning" : "default"}
                  >
                    <s-stack direction="block" gap="tight">
                      <s-stack direction="inline" gap="tight">
                        <s-badge tone={isAddonBundle ? "critical" : "info"}>{mf.namespace}</s-badge>
                        <s-text variant="headingSm">{mf.key}</s-text>
                        {isAddonBundle && <s-badge tone="warning">ADDON BUNDLE</s-badge>}
                      </s-stack>
                      <s-text variant="bodySm" color="subdued" style={{ wordBreak: "break-all" }}>
                        {mf.value.length > 200 ? mf.value.substring(0, 200) + "..." : mf.value}
                      </s-text>
                      {isAddonBundle && (
                        <button
                          style={{
                            background: "#d72c0d",
                            border: "none",
                            color: "#fff",
                            cursor: "pointer",
                            fontSize: "14px",
                            padding: "8px 16px",
                            borderRadius: "4px",
                          }}
                          onClick={() => handleClearMetafield(mf.namespace, mf.key)}
                        >
                          Delete this metafield
                        </button>
                      )}
                    </s-stack>
                  </s-box>
                );
              })}
            </s-stack>
          )}
        </s-stack>
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
