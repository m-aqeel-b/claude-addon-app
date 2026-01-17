/**
 * Discount Sync Service
 * Manages Shopify automatic discounts linked to the add-on bundle discount function
 */

import type { BundleWithRelations } from "../models/bundle.server";

// Admin API client type
interface AdminGraphQLClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<{
    json: () => Promise<{ data?: Record<string, unknown>; errors?: Array<{ message: string }> }>;
  }>;
}
import { updateBundle } from "../models/bundle.server";
import { getAddOnSets } from "../models/addOnSet.server";
import { buildDiscountConfig } from "./metafield.sync";

// The app name for matching (slugified version of app name from shopify.app.toml)
const APP_NAME_PATTERNS = ["claude-addon-bundle-app", "addon-bundle"];

interface CreateDiscountResult {
  discountId: string | null;
  errors: Array<{ field: string; message: string }>;
}

interface UpdateDiscountResult {
  success: boolean;
  errors: Array<{ field: string; message: string }>;
}

// GraphQL response types
interface UserError {
  field: string;
  message: string;
}

interface DiscountAutomaticAppCreateResponse {
  discountAutomaticAppCreate?: {
    automaticAppDiscount?: {
      discountId: string;
    };
    userErrors?: UserError[];
  };
}

interface DiscountAutomaticAppUpdateResponse {
  discountAutomaticAppUpdate?: {
    userErrors?: UserError[];
  };
}

interface DiscountAutomaticDeleteResponse {
  discountAutomaticDelete?: {
    userErrors?: UserError[];
  };
}

interface ShopifyFunctionsResponse {
  shopifyFunctions?: {
    nodes?: Array<{
      id: string;
      apiType: string;
      title: string;
      app?: {
        handle: string;
      };
    }>;
  };
}

/**
 * Create an automatic discount for a bundle
 */
export async function createBundleDiscount(
  admin: AdminGraphQLClient,
  shop: string,
  bundle: BundleWithRelations
): Promise<CreateDiscountResult> {
  console.log("[createBundleDiscount] Starting discount creation for bundle:", bundle.id, bundle.title);

  const addOnSets = await getAddOnSets(bundle.id);
  console.log("[createBundleDiscount] Found", addOnSets.length, "add-on sets");

  const discountConfig = buildDiscountConfig(bundle, addOnSets);
  console.log("[createBundleDiscount] Built discount config with", discountConfig.addOns.length, "add-ons");

  // Build combination settings
  const combinesWithProductDiscounts = bundle.combineWithProductDiscounts === "COMBINE";
  const combinesWithOrderDiscounts = bundle.combineWithOrderDiscounts === "COMBINE";
  const combinesWithShippingDiscounts = bundle.combineWithShippingDiscounts === "COMBINE";

  // Get function ID first
  let functionId: string;
  try {
    functionId = await getFunctionId(admin);
    console.log("[createBundleDiscount] Got function ID:", functionId);
  } catch (error) {
    console.error("[createBundleDiscount] Failed to get function ID:", error);
    return {
      discountId: null,
      errors: [{ field: "functionId", message: error instanceof Error ? error.message : "Failed to find discount function" }],
    };
  }

  const response = await admin.graphql(
    `#graphql
    mutation CreateAutomaticDiscount($discount: DiscountAutomaticAppInput!) {
      discountAutomaticAppCreate(automaticAppDiscount: $discount) {
        automaticAppDiscount {
          discountId
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        discount: {
          title: `Add-On Bundle: ${bundle.title}`,
          functionId,
          startsAt: bundle.startDate?.toISOString() || new Date().toISOString(),
          endsAt: bundle.endDate?.toISOString() || null,
          combinesWith: {
            productDiscounts: combinesWithProductDiscounts,
            orderDiscounts: combinesWithOrderDiscounts,
            shippingDiscounts: combinesWithShippingDiscounts,
          },
          // Required for new unified Discount API - specifies what discount types this function generates
          discountClasses: ["PRODUCT"],
          metafields: [
            {
              namespace: "$app:addon-bundle",
              key: "config",
              value: JSON.stringify(discountConfig),
              type: "json",
            },
          ],
        },
      },
    }
  );

  const data = await response.json();
  console.log("[createBundleDiscount] GraphQL response:", JSON.stringify(data, null, 2));

  // Check for GraphQL errors
  if (data.errors && data.errors.length > 0) {
    console.error("[createBundleDiscount] GraphQL errors:", data.errors);
    return {
      discountId: null,
      errors: data.errors.map((e: { message: string }) => ({ field: "graphql", message: e.message })),
    };
  }

  const result = (data.data as DiscountAutomaticAppCreateResponse)?.discountAutomaticAppCreate;

  if (result?.userErrors && result.userErrors.length > 0) {
    console.error("[createBundleDiscount] User errors:", result.userErrors);
    return {
      discountId: null,
      errors: result.userErrors,
    };
  }

  const discountId = result?.automaticAppDiscount?.discountId || null;
  console.log("[createBundleDiscount] Created discount ID:", discountId);

  // Store the discount ID in the bundle
  if (discountId) {
    await updateBundle(bundle.id, shop, { shopifyDiscountId: discountId });
  }

  return {
    discountId,
    errors: [],
  };
}

/**
 * Update an existing automatic discount for a bundle
 */
export async function updateBundleDiscount(
  admin: AdminGraphQLClient,
  bundle: BundleWithRelations
): Promise<UpdateDiscountResult> {
  if (!bundle.shopifyDiscountId) {
    return { success: false, errors: [{ field: "discountId", message: "No discount ID found" }] };
  }

  const addOnSets = await getAddOnSets(bundle.id);
  const discountConfig = buildDiscountConfig(bundle, addOnSets);

  const combinesWithProductDiscounts = bundle.combineWithProductDiscounts === "COMBINE";
  const combinesWithOrderDiscounts = bundle.combineWithOrderDiscounts === "COMBINE";
  const combinesWithShippingDiscounts = bundle.combineWithShippingDiscounts === "COMBINE";

  // First update the discount settings (without metafields - those need separate mutation)
  const response = await admin.graphql(
    `#graphql
    mutation UpdateAutomaticDiscount($id: ID!, $discount: DiscountAutomaticAppInput!) {
      discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $discount) {
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        id: bundle.shopifyDiscountId,
        discount: {
          title: `Add-On Bundle: ${bundle.title}`,
          startsAt: bundle.startDate?.toISOString() || new Date().toISOString(),
          endsAt: bundle.endDate?.toISOString() || null,
          combinesWith: {
            productDiscounts: combinesWithProductDiscounts,
            orderDiscounts: combinesWithOrderDiscounts,
            shippingDiscounts: combinesWithShippingDiscounts,
          },
          // Required for new unified Discount API
          discountClasses: ["PRODUCT"],
        },
      },
    }
  );

  const data = await response.json();
  const result = (data.data as DiscountAutomaticAppUpdateResponse)?.discountAutomaticAppUpdate;
  const errors = result?.userErrors || [];

  if (errors.length > 0) {
    return { success: false, errors };
  }

  // Now update the metafield using metafieldsSet mutation
  const metafieldResponse = await admin.graphql(
    `#graphql
    mutation UpdateDiscountMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: bundle.shopifyDiscountId,
            namespace: "$app:addon-bundle",
            key: "config",
            value: JSON.stringify(discountConfig),
            type: "json",
          },
        ],
      },
    }
  );

  const metafieldData = await metafieldResponse.json();
  const metafieldResult = (metafieldData.data as { metafieldsSet?: { userErrors?: UserError[] } })?.metafieldsSet;
  const metafieldErrors = metafieldResult?.userErrors || [];

  return {
    success: metafieldErrors.length === 0,
    errors: metafieldErrors,
  };
}

/**
 * Delete an automatic discount for a bundle
 */
export async function deleteBundleDiscount(
  admin: AdminGraphQLClient,
  discountId: string
): Promise<UpdateDiscountResult> {
  const response = await admin.graphql(
    `#graphql
    mutation DeleteAutomaticDiscount($id: ID!) {
      discountAutomaticDelete(id: $id) {
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: { id: discountId },
    }
  );

  const data = await response.json();
  const result = (data.data as DiscountAutomaticDeleteResponse)?.discountAutomaticDelete;
  const errors = result?.userErrors || [];

  return {
    success: errors.length === 0,
    errors,
  };
}

/**
 * Activate a bundle (create discount if needed, enable it)
 */
export async function activateBundleDiscount(
  admin: AdminGraphQLClient,
  shop: string,
  bundle: BundleWithRelations
): Promise<UpdateDiscountResult> {
  // If no discount exists, create one
  if (!bundle.shopifyDiscountId) {
    const result = await createBundleDiscount(admin, shop, bundle);
    return {
      success: result.discountId !== null,
      errors: result.errors,
    };
  }

  // Otherwise update the existing one
  return updateBundleDiscount(admin, bundle);
}

/**
 * Deactivate a bundle (delete the discount)
 */
export async function deactivateBundleDiscount(
  admin: AdminGraphQLClient,
  shop: string,
  bundle: BundleWithRelations
): Promise<UpdateDiscountResult> {
  if (!bundle.shopifyDiscountId) {
    return { success: true, errors: [] };
  }

  const result = await deleteBundleDiscount(admin, bundle.shopifyDiscountId);

  if (result.success) {
    await updateBundle(bundle.id, shop, { shopifyDiscountId: null });
  }

  return result;
}

/**
 * Get the function ID for our discount extension
 * This is needed to create automatic discounts linked to the function
 */
async function getFunctionId(admin: AdminGraphQLClient): Promise<string> {
  console.log("[getFunctionId] Starting function lookup...");

  const response = await admin.graphql(
    `#graphql
    query GetFunctionId {
      shopifyFunctions(first: 100) {
        nodes {
          id
          apiType
          title
          app {
            handle
          }
        }
      }
    }`
  );

  const data = await response.json();

  // Check for GraphQL errors
  if (data.errors && data.errors.length > 0) {
    console.error("[getFunctionId] GraphQL errors:", JSON.stringify(data.errors));
    throw new Error(`GraphQL error: ${data.errors.map((e: { message: string }) => e.message).join(", ")}`);
  }

  const result = (data.data as ShopifyFunctionsResponse)?.shopifyFunctions;
  const functions = result?.nodes || [];

  console.log("[getFunctionId] Total functions found:", functions.length);
  console.log("[getFunctionId] All available functions:",
    JSON.stringify(functions.map(fn => ({ id: fn.id, apiType: fn.apiType, title: fn.title, appHandle: fn.app?.handle })), null, 2)
  );

  // Filter to discount functions (various API types used by Shopify)
  // - "discount" (singular) - used by newer unified Discount API
  // - "discounts" (plural) - also used by unified Discount API
  // - "product_discounts" - legacy Product Discount API
  const discountFunctions = functions.filter(
    (fn) => fn.apiType === "discount" || fn.apiType === "discounts" || fn.apiType === "product_discounts"
  );

  console.log("[getFunctionId] Discount functions found:", discountFunctions.length);
  console.log("[getFunctionId] Discount functions:",
    JSON.stringify(discountFunctions.map(fn => ({ id: fn.id, apiType: fn.apiType, title: fn.title, appHandle: fn.app?.handle })), null, 2)
  );

  // Try to find our function by app handle patterns
  let discountFunction = discountFunctions.find(
    (fn) => APP_NAME_PATTERNS.some(pattern =>
      fn.app?.handle?.toLowerCase().includes(pattern.toLowerCase())
    )
  );
  console.log("[getFunctionId] Found by handle pattern:", !!discountFunction);

  // If not found by handle, try by title containing our app name patterns
  if (!discountFunction) {
    discountFunction = discountFunctions.find(
      (fn) => APP_NAME_PATTERNS.some(pattern =>
        fn.title?.toLowerCase().includes(pattern.toLowerCase())
      )
    );
    console.log("[getFunctionId] Found by title pattern:", !!discountFunction);
  }

  // If still not found, try by title containing "addon" or "bundle"
  if (!discountFunction) {
    discountFunction = discountFunctions.find(
      (fn) => fn.title?.toLowerCase().includes("addon") || fn.title?.toLowerCase().includes("bundle")
    );
    console.log("[getFunctionId] Found by addon/bundle keyword:", !!discountFunction);
  }

  // If still not found and there's only one discount function, use it
  if (!discountFunction && discountFunctions.length === 1) {
    console.log("[getFunctionId] Using single available discount function");
    discountFunction = discountFunctions[0];
  }

  // If still not found and there are multiple, use the first one (dev convenience)
  if (!discountFunction && discountFunctions.length > 0) {
    console.log("[getFunctionId] Using first available discount function as fallback");
    discountFunction = discountFunctions[0];
  }

  if (!discountFunction) {
    const errorMsg = `Discount function not found. Make sure the extension is deployed with 'npm run deploy'. Found ${functions.length} total functions, ${discountFunctions.length} discount functions. All functions: ${JSON.stringify(functions.map(f => ({ apiType: f.apiType, handle: f.app?.handle, title: f.title })))}`;
    console.error("[getFunctionId]", errorMsg);
    throw new Error(errorMsg);
  }

  console.log("[getFunctionId] Selected function:", discountFunction.id, discountFunction.title);
  return discountFunction.id;
}

/**
 * Check if the discount function is installed/available
 */
export async function isDiscountFunctionAvailable(
  admin: AdminGraphQLClient
): Promise<boolean> {
  try {
    await getFunctionId(admin);
    return true;
  } catch {
    return false;
  }
}
