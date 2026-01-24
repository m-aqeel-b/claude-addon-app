/**
 * Cart Transform Function: Addon Bundle Cart Manager
 *
 * NOTE: Cart Transform Function API does NOT support removing cart lines.
 * Available operations are only: expand, merge, update.
 *
 * The automatic removal of add-on products when their main product is removed
 * is handled by Shopify's NESTED CART LINES feature, which is implemented
 * in the client-side JavaScript (addon-bundle.js).
 *
 * When adding add-ons to the cart with `deleteAddonsOnMainDelete` enabled,
 * the JavaScript adds `parent_id` to the add-on items, creating a parent-child
 * relationship. Shopify automatically removes child items when the parent is removed.
 *
 * This Cart Transform function is kept as a placeholder for potential future use:
 * - Bundle expansion/presentation
 * - Merging bundle items for display
 * - Price updates for bundle discounts
 */

import type { RunInput, FunctionRunResult } from "../generated/api";

/**
 * Main entry point for the Cart Transform function
 * Currently returns empty operations as removal is handled by nested cart lines
 */
export function run(_input: RunInput): FunctionRunResult {
  // Cart Transform cannot remove items - return empty operations
  // Removal is handled by Shopify's Nested Cart Lines feature (parent_id)
  return { operations: [] };
}
