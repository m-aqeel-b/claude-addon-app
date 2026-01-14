import {
  DeliveryInput,
  CartDeliveryOptionsDiscountsGenerateRunResult,
} from "../generated/api";

/**
 * Delivery options discount function for add-on bundles.
 * Currently not used - add-on bundles only apply product discounts.
 * This target is required by the extension but returns no operations.
 */
export function cartDeliveryOptionsDiscountsGenerateRun(
  _input: DeliveryInput,
): CartDeliveryOptionsDiscountsGenerateRunResult {
  // Add-on bundles don't apply shipping discounts
  return { operations: [] };
}