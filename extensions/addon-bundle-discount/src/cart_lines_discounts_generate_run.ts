import {
  DiscountClass,
  ProductDiscountSelectionStrategy,
  CartLinesDiscountsGenerateRunResult,
  ProductDiscountCandidate,
  ProductDiscountCandidateValue,
} from '../generated/api';

/**
 * Add-on configuration from discount metafield
 * This matches the structure from buildDiscountConfig in metafield.sync.ts
 */
interface AddOnConfig {
  addOnId: string;
  productTitle: string;
  imageUrl: string | null;
  title: string | null;
  targetVariantIds: string[]; // Array of variant GIDs
  discountType: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'FIXED_PRICE' | 'FREE_GIFT';
  discountValue: number | null;
  discountLabel: string | null;
  isDefaultSelected: boolean;
  subscriptionOnly: boolean;
  showQuantitySelector: boolean;
  maxQuantity: number;
  message: string;
}

interface BundleConfig {
  bundleId: string;
  addOns: AddOnConfig[];
  selectionStrategy: 'FIRST' | 'ALL';
}

/**
 * Input types for the function
 */
interface CartLine {
  id: string;
  quantity: number;
  cost: {
    amountPerQuantity: {
      amount: string;
    };
  };
  addonBundleId?: {
    value: string;
  } | null;
  merchandise: {
    __typename: string;
    id?: string;
    product?: {
      id: string;
    };
  };
  sellingPlanAllocation?: {
    sellingPlan: {
      id: string;
    };
  } | null;
}

interface FunctionInput {
  cart: {
    lines: CartLine[];
  };
  discount: {
    metafield?: {
      value: string;
    } | null;
    discountClasses: DiscountClass[];
  };
}

export function cartLinesDiscountsGenerateRun(
  input: FunctionInput,
): CartLinesDiscountsGenerateRunResult {
  // Debug: Log function start
  console.error('[AddonDiscount] Function called');
  console.error('[AddonDiscount] Cart lines count:', input.cart.lines.length);
  console.error('[AddonDiscount] Discount classes:', JSON.stringify(input.discount.discountClasses));

  // Return early if no cart lines
  if (!input.cart.lines.length) {
    console.error('[AddonDiscount] No cart lines, returning empty');
    return { operations: [] };
  }

  // Check if we have product discount class
  const hasProductDiscountClass = input.discount.discountClasses.includes(
    DiscountClass.Product,
  );

  console.error('[AddonDiscount] Has product discount class:', hasProductDiscountClass);

  if (!hasProductDiscountClass) {
    console.error('[AddonDiscount] No product discount class, returning empty');
    return { operations: [] };
  }

  // Get bundle config from discount metafield
  const metafieldValue = input.discount.metafield?.value;
  console.error('[AddonDiscount] Metafield value exists:', !!metafieldValue);

  if (!metafieldValue) {
    console.error('[AddonDiscount] No metafield value, returning empty');
    return { operations: [] };
  }

  let config: BundleConfig;
  try {
    config = JSON.parse(metafieldValue) as BundleConfig;
    console.error('[AddonDiscount] Config parsed, bundleId:', config.bundleId);
    console.error('[AddonDiscount] AddOns count:', config.addOns?.length || 0);
  } catch (e) {
    console.error('[AddonDiscount] Failed to parse config:', e);
    return { operations: [] };
  }

  if (!config || !config.addOns || config.addOns.length === 0) {
    console.error('[AddonDiscount] No addOns in config, returning empty');
    return { operations: [] };
  }

  // Build a map of variant ID to add-on config for quick lookup
  const variantToAddOn = new Map<string, AddOnConfig>();
  for (const addOn of config.addOns) {
    console.error('[AddonDiscount] AddOn:', addOn.addOnId, 'targetVariantIds:', JSON.stringify(addOn.targetVariantIds));
    for (const variantId of addOn.targetVariantIds) {
      variantToAddOn.set(variantId, addOn);
    }
  }

  console.error('[AddonDiscount] Variant map size:', variantToAddOn.size);

  // Build discount candidates for cart lines that are add-ons
  const candidates: ProductDiscountCandidate[] = [];

  // Debug: Log all cart lines
  for (const line of input.cart.lines) {
    console.error('[AddonDiscount] Cart line:', line.id);
    console.error('[AddonDiscount]   - typename:', line.merchandise.__typename);
    console.error('[AddonDiscount]   - variantId:', line.merchandise.id);
    console.error('[AddonDiscount]   - addonBundleId:', line.addonBundleId?.value || 'NOT SET');
  }

  for (const line of input.cart.lines) {
    // Only process lines that have the _addon_bundle_id attribute
    // This identifies them as add-on items added via the widget
    if (!line.addonBundleId?.value) {
      console.error('[AddonDiscount] Skipping line (no addonBundleId):', line.id);
      continue;
    }

    console.error('[AddonDiscount] Processing add-on line:', line.id, 'bundleId:', line.addonBundleId.value);

    // Only process ProductVariant merchandise
    if (line.merchandise.__typename !== 'ProductVariant') {
      console.error('[AddonDiscount] Skipping line (not ProductVariant):', line.id);
      continue;
    }

    const variantId = line.merchandise.id;
    if (!variantId) {
      console.error('[AddonDiscount] Skipping line (no variantId):', line.id);
      continue;
    }

    console.error('[AddonDiscount] Looking up variant:', variantId);

    // Find the add-on config for this variant
    const addOn = variantToAddOn.get(variantId);
    if (!addOn) {
      console.error('[AddonDiscount] No addOn config found for variant:', variantId);
      console.error('[AddonDiscount] Available variants in map:', Array.from(variantToAddOn.keys()));
      continue;
    }

    console.error('[AddonDiscount] Found addOn config:', addOn.addOnId, 'discountType:', addOn.discountType, 'discountValue:', addOn.discountValue);

    // Skip if no discount configured
    if (!addOn.discountType || (addOn.discountType !== 'FREE_GIFT' && !addOn.discountValue)) {
      continue;
    }

    // Check subscription-only restriction
    if (addOn.subscriptionOnly && !line.sellingPlanAllocation) {
      continue;
    }

    // Calculate quantity to discount (respecting max quantity)
    const quantityToDiscount = Math.min(line.quantity, addOn.maxQuantity || 99);

    // Calculate discount value based on type
    let discountValue: ProductDiscountCandidateValue;
    const discountAmount = addOn.discountValue || 0;

    switch (addOn.discountType) {
      case 'PERCENTAGE':
        discountValue = {
          percentage: {
            value: discountAmount,
          },
        };
        break;

      case 'FIXED_AMOUNT':
        discountValue = {
          fixedAmount: {
            amount: discountAmount.toString(),
            appliesToEachItem: true,
          },
        };
        break;

      case 'FIXED_PRICE': {
        // Calculate discount as: original price - target price
        const originalPrice = parseFloat(line.cost.amountPerQuantity.amount);
        const targetPrice = discountAmount;

        // Only apply if target price is less than original
        if (targetPrice >= originalPrice) {
          continue;
        }

        const amountOff = originalPrice - targetPrice;
        discountValue = {
          fixedAmount: {
            amount: amountOff.toFixed(2),
            appliesToEachItem: true,
          },
        };
        break;
      }

      case 'FREE_GIFT':
        // 100% off for free gifts
        discountValue = {
          percentage: {
            value: 100,
          },
        };
        break;

      default:
        continue;
    }

    // Create discount message
    const message = addOn.discountLabel ||
      (addOn.discountType === 'FREE_GIFT' ? 'Free Gift' : `Add-On Discount`);

    candidates.push({
      message,
      targets: [
        {
          cartLine: {
            id: line.id,
            quantity: quantityToDiscount,
          },
        },
      ],
      value: discountValue,
    });
  }

  // Return early if no discounts to apply
  console.error('[AddonDiscount] Total candidates created:', candidates.length);

  if (candidates.length === 0) {
    console.error('[AddonDiscount] No candidates, returning empty operations');
    return { operations: [] };
  }

  console.error('[AddonDiscount] Returning', candidates.length, 'discount candidates');
  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates,
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}
