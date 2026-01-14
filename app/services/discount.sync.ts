/**
 * Discount Sync Service
 * Manages Shopify automatic discounts linked to the add-on bundle discount function
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { BundleWithRelations } from "../models/bundle.server";
import { updateBundle } from "../models/bundle.server";
import { getAddOnSets } from "../models/addOnSet.server";
import { buildDiscountConfig } from "./metafield.sync";

// The function extension handle
const FUNCTION_HANDLE = "addon-bundle-discount";

interface CreateDiscountResult {
  discountId: string | null;
  errors: Array<{ field: string; message: string }>;
}

interface UpdateDiscountResult {
  success: boolean;
  errors: Array<{ field: string; message: string }>;
}

/**
 * Create an automatic discount for a bundle
 */
export async function createBundleDiscount(
  admin: AdminApiContext["admin"],
  shop: string,
  bundle: BundleWithRelations
): Promise<CreateDiscountResult> {
  const addOnSets = await getAddOnSets(bundle.id);
  const discountConfig = buildDiscountConfig(bundle, addOnSets);

  // Build combination settings
  const combinesWithProductDiscounts = bundle.combineWithProductDiscounts === "COMBINE";
  const combinesWithOrderDiscounts = bundle.combineWithOrderDiscounts === "COMBINE";
  const combinesWithShippingDiscounts = bundle.combineWithShippingDiscounts === "COMBINE";

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
          functionId: await getFunctionId(admin),
          startsAt: bundle.startDate?.toISOString() || new Date().toISOString(),
          endsAt: bundle.endDate?.toISOString() || null,
          combinesWith: {
            productDiscounts: combinesWithProductDiscounts,
            orderDiscounts: combinesWithOrderDiscounts,
            shippingDiscounts: combinesWithShippingDiscounts,
          },
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
  const result = data.data?.discountAutomaticAppCreate;

  if (result?.userErrors?.length > 0) {
    return {
      discountId: null,
      errors: result.userErrors,
    };
  }

  const discountId = result?.automaticAppDiscount?.discountId;

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
  admin: AdminApiContext["admin"],
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
  const errors = data.data?.discountAutomaticAppUpdate?.userErrors || [];

  return {
    success: errors.length === 0,
    errors,
  };
}

/**
 * Delete an automatic discount for a bundle
 */
export async function deleteBundleDiscount(
  admin: AdminApiContext["admin"],
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
  const errors = data.data?.discountAutomaticDelete?.userErrors || [];

  return {
    success: errors.length === 0,
    errors,
  };
}

/**
 * Activate a bundle (create discount if needed, enable it)
 */
export async function activateBundleDiscount(
  admin: AdminApiContext["admin"],
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
  admin: AdminApiContext["admin"],
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
async function getFunctionId(admin: AdminApiContext["admin"]): Promise<string> {
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
  const functions = data.data?.shopifyFunctions?.nodes || [];

  // Find our function by handle
  const discountFunction = functions.find(
    (fn: { apiType: string; app?: { handle: string } }) =>
      fn.apiType === "product_discounts" && fn.app?.handle === FUNCTION_HANDLE
  );

  if (!discountFunction) {
    throw new Error(
      `Discount function not found. Make sure the extension is deployed.`
    );
  }

  return discountFunction.id;
}

/**
 * Check if the discount function is installed/available
 */
export async function isDiscountFunctionAvailable(
  admin: AdminApiContext["admin"]
): Promise<boolean> {
  try {
    await getFunctionId(admin);
    return true;
  } catch {
    return false;
  }
}
