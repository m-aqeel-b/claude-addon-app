/**
 * Add-On Bundle Widget JavaScript
 * Handles selection state and adds selected add-ons to cart with main product
 */

(function () {
  'use strict';

  // State management
  const state = {
    selectedAddOns: new Map(),
    bundleId: null,
    productId: null,
    deleteAddonsOnMainDelete: false, // Per-bundle setting for Cart Transform
    showSoldOutLabel: false, // Show sold-out label for out-of-stock variants
    soldOutLabelText: 'Sold out', // Custom label text for sold-out items
    initialized: false,
    isInternalRequest: false, // Flag to prevent double-interception
  };

  /**
   * Generate a unique bundle group ID for this add-to-cart action
   * This links the main product and its addons together in the cart
   */
  function generateBundleGroupId() {
    return 'bg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
  }

  /**
   * Extract numeric ID from Shopify GID
   */
  function extractNumericId(gidOrId) {
    if (!gidOrId) return null;
    const str = String(gidOrId);
    if (str.includes('gid://')) {
      const parts = str.split('/');
      return parts[parts.length - 1];
    }
    return str;
  }

  /**
   * Initialize the widget
   */
  function init() {
    if (state.initialized) return;

    const widget = document.querySelector('.addon-bundle-widget');
    if (!widget) return;

    state.bundleId = widget.dataset.bundleId;
    state.productId = widget.dataset.productId;
    state.deleteAddonsOnMainDelete = widget.dataset.deleteAddonsOnMainDelete === 'true';
    state.showSoldOutLabel = widget.dataset.showSoldOutLabel === 'true';
    state.soldOutLabelText = widget.dataset.soldOutLabelText || 'Sold out';
    state.initialized = true;

    console.log('[AddonBundle] Widget initialized', {
      bundleId: state.bundleId,
      deleteAddonsOnMainDelete: state.deleteAddonsOnMainDelete,
      showSoldOutLabel: state.showSoldOutLabel,
      soldOutLabelText: state.soldOutLabelText
    });

    // Setup all listeners
    setupSelectionListeners();
    setupVariantListeners();
    setupQuantityListeners();
    initializeSelections();

    // Initialize countdown timer if present
    initCountdownTimer();

    // Fetch and update prices for current market/region
    fetchMarketPrices();

    // CRITICAL: Override the add to cart behavior
    overrideAddToCart();

    // Start cart monitoring for auto-removal of orphaned add-ons
    initCartMonitoring();
  }

  /**
   * Fetch market-specific prices for all add-on products
   * Uses Shopify's AJAX API which automatically returns prices in the current market's currency
   */
  async function fetchMarketPrices() {
    const addonItems = document.querySelectorAll('.addon-item');
    if (addonItems.length === 0) return;

    // Collect all unique product handles from data attributes
    const productHandles = new Map(); // handle -> array of addon elements

    addonItems.forEach(item => {
      const handle = item.dataset.productHandle;
      if (handle) {
        if (!productHandles.has(handle)) {
          productHandles.set(handle, []);
        }
        productHandles.get(handle).push(item);
      }
    });

    if (productHandles.size === 0) {
      console.log('[AddonBundle] No product handles found for price fetching');
      return;
    }

    console.log('[AddonBundle] Fetching market prices for', productHandles.size, 'products');

    // Fetch each product's data and update prices
    const fetchPromises = [];
    productHandles.forEach((items, handle) => {
      fetchPromises.push(
        fetchProductPrices(handle)
          .then(productData => {
            if (productData) {
              updateAddonPrices(items, productData);
            }
          })
          .catch(err => {
            console.error('[AddonBundle] Error fetching prices for', handle, err);
          })
      );
    });

    await Promise.all(fetchPromises);
    console.log('[AddonBundle] Market prices updated');
  }

  /**
   * Fetch product data from Shopify AJAX API
   * Returns product with market-specific prices
   */
  async function fetchProductPrices(handle) {
    try {
      const response = await fetch(`/products/${handle}.js`);
      if (!response.ok) {
        console.warn('[AddonBundle] Failed to fetch product:', handle, response.status);
        return null;
      }
      return await response.json();
    } catch (error) {
      console.error('[AddonBundle] Error fetching product:', handle, error);
      return null;
    }
  }

  /**
   * Update addon item prices with market-specific data
   * Also updates sold-out states based on inventory availability
   */
  function updateAddonPrices(addonItems, productData) {
    if (!productData || !productData.variants) return;

    // Create a map of variant ID to variant data for quick lookup
    const variantMap = new Map();
    let availableVariantCount = 0;
    let totalVariantCount = productData.variants.length;

    productData.variants.forEach(variant => {
      variantMap.set(String(variant.id), variant);
      if (variant.available) {
        availableVariantCount++;
      }
    });

    const allVariantsSoldOut = availableVariantCount === 0;

    addonItems.forEach(item => {
      const variantId = extractNumericId(item.dataset.variantId);
      if (!variantId) return;

      const variant = variantMap.get(variantId);
      if (!variant) {
        console.warn('[AddonBundle] Variant not found:', variantId, 'in product', productData.handle);
        return;
      }

      // Get the market price (in cents, convert to dollars)
      const marketPrice = variant.price / 100;

      // Update the data attribute with the new price
      item.dataset.originalPrice = marketPrice;

      // Get discount info from the input element
      const input = item.querySelector('.addon-item__input');
      const discountType = input?.dataset.discountType;
      const discountValue = parseFloat(input?.dataset.discountValue) || 0;

      // Calculate discounted price
      let discountedPrice = marketPrice;
      let hasDiscount = false;

      switch (discountType) {
        case 'PERCENTAGE':
          if (discountValue > 0) {
            discountedPrice = marketPrice - (marketPrice * discountValue / 100);
            hasDiscount = true;
          }
          break;
        case 'FIXED_AMOUNT':
          if (discountValue > 0) {
            discountedPrice = Math.max(0, marketPrice - discountValue);
            hasDiscount = true;
          }
          break;
        case 'FIXED_PRICE':
          discountedPrice = discountValue;
          hasDiscount = true;
          break;
        case 'FREE_GIFT':
          discountedPrice = 0;
          hasDiscount = true;
          break;
      }

      item.dataset.discountedPrice = discountedPrice;

      // Update the price display in the DOM
      const priceRow = item.querySelector('.addon-item__price-row');
      if (priceRow) {
        // Format prices using the shop's currency format
        const formattedOriginal = formatMoney(marketPrice * 100);
        const formattedDiscounted = discountedPrice === 0 ? 'FREE' : formatMoney(discountedPrice * 100);

        if (hasDiscount) {
          priceRow.innerHTML = `
            <span class="addon-item__price addon-item__price--original">${formattedOriginal}</span>
            <span class="addon-item__price addon-item__price--discounted">${formattedDiscounted}</span>
          `;
        } else {
          priceRow.innerHTML = `
            <span class="addon-item__price">${formattedOriginal}</span>
          `;
        }
      }

      // Update sold-out state dynamically based on real-time inventory
      if (state.showSoldOutLabel) {
        updateSoldOutState(item, variant, variantMap, allVariantsSoldOut);
      }

      // Also update variant select dropdown if present
      const variantSelect = item.querySelector('.addon-item__variant-select');
      if (variantSelect) {
        Array.from(variantSelect.options).forEach(option => {
          const optionVariantId = option.value;
          const optionVariant = variantMap.get(extractNumericId(optionVariantId));
          if (optionVariant) {
            const optionPrice = optionVariant.price / 100;
            option.dataset.price = optionPrice;
            // Update option text to show new price and sold-out status
            const variantTitle = optionVariant.title || optionVariant.option1;
            const soldOutSuffix = (!optionVariant.available && state.showSoldOutLabel) ? ` (${state.soldOutLabelText})` : '';
            option.textContent = `${variantTitle} - ${formatMoney(optionVariant.price)}${soldOutSuffix}`;

            // Update sold-out attribute and disabled state
            if (!optionVariant.available && state.showSoldOutLabel) {
              option.dataset.soldOut = 'true';
              option.disabled = true;
            } else {
              option.dataset.soldOut = 'false';
              option.disabled = false;
            }
          }
        });

        // If currently selected option is sold out, try to select an available one
        if (variantSelect.selectedOptions[0]?.dataset.soldOut === 'true') {
          const availableOption = Array.from(variantSelect.options).find(
            opt => opt.dataset.soldOut !== 'true' && !opt.disabled
          );
          if (availableOption) {
            variantSelect.value = availableOption.value;
            variantSelect.dispatchEvent(new Event('change'));
          }
        }
      }
    });
  }

  /**
   * Update sold-out state for a single addon item
   */
  function updateSoldOutState(item, variant, variantMap, allVariantsSoldOut) {
    const input = item.querySelector('.addon-item__input');
    const checkbox = item.querySelector('.addon-item__checkbox-custom');
    const hasMultipleVariants = item.dataset.hasMultipleVariants === 'true';

    // Determine if this item should show as sold out
    const isSoldOut = allVariantsSoldOut || (!hasMultipleVariants && !variant.available);

    if (isSoldOut) {
      // Add sold-out classes
      item.classList.add('addon-item--sold-out');
      if (allVariantsSoldOut) {
        item.classList.add('addon-item--all-sold-out');
      }

      // Disable input
      if (input) {
        input.disabled = true;
        input.checked = false;
      }
      if (checkbox) {
        checkbox.classList.add('addon-item__checkbox-custom--disabled');
      }

      // Add overlay if not already present
      if (!item.querySelector('.addon-item__sold-out-overlay')) {
        const overlay = document.createElement('div');
        overlay.className = 'addon-item__sold-out-overlay';
        overlay.innerHTML = `<span class="addon-item__sold-out-label">${state.soldOutLabelText}</span>`;
        item.insertBefore(overlay, item.firstChild);
      }

      // Update data attributes
      item.dataset.soldOut = 'true';
      item.dataset.allVariantsSoldOut = String(allVariantsSoldOut);

      // Remove from selections if was selected
      const addonId = item.dataset.addonId;
      if (state.selectedAddOns.has(addonId)) {
        state.selectedAddOns.delete(addonId);
        item.classList.remove('addon-item--selected');
        console.log('[AddonBundle] Removed sold-out item from selections:', addonId);
      }
    } else {
      // Remove sold-out state if item is now available
      item.classList.remove('addon-item--sold-out', 'addon-item--all-sold-out');

      if (input) {
        input.disabled = false;
      }
      if (checkbox) {
        checkbox.classList.remove('addon-item__checkbox-custom--disabled');
      }

      // Remove overlay
      const overlay = item.querySelector('.addon-item__sold-out-overlay');
      if (overlay) {
        overlay.remove();
      }

      // Update data attributes
      item.dataset.soldOut = 'false';
      item.dataset.allVariantsSoldOut = 'false';
    }
  }

  /**
   * Format money using Shopify's money format
   * Falls back to basic formatting if Shopify.formatMoney is not available
   */
  function formatMoney(cents) {
    // Try to use Shopify's built-in formatMoney if available
    if (window.Shopify && window.Shopify.formatMoney) {
      return window.Shopify.formatMoney(cents, window.theme?.moneyFormat || '${{amount}}');
    }

    // Fallback: basic currency formatting
    const amount = (cents / 100).toFixed(2);
    const currencySymbol = window.Shopify?.currency?.symbol || '$';
    return `${currencySymbol}${amount}`;
  }

  /**
   * Initialize countdown timer
   */
  function initCountdownTimer() {
    const countdownEl = document.querySelector('.addon-bundle-widget__countdown');
    if (!countdownEl) return;

    const endDateStr = countdownEl.dataset.countdownTarget;
    if (!endDateStr) return;

    const endDate = new Date(endDateStr);
    if (isNaN(endDate.getTime())) {
      console.error('[AddonBundle] Invalid countdown end date:', endDateStr);
      return;
    }

    console.log('[AddonBundle] Countdown initialized, ends:', endDate);

    const daysEl = countdownEl.querySelector('[data-days]');
    const hoursEl = countdownEl.querySelector('[data-hours]');
    const minutesEl = countdownEl.querySelector('[data-minutes]');
    const secondsEl = countdownEl.querySelector('[data-seconds]');
    const countdownContainer = countdownEl.querySelector('.addon-countdown');

    function updateCountdown() {
      const now = new Date();
      const diff = endDate - now;

      if (diff <= 0) {
        // Countdown expired
        if (daysEl) daysEl.textContent = '00';
        if (hoursEl) hoursEl.textContent = '00';
        if (minutesEl) minutesEl.textContent = '00';
        if (secondsEl) secondsEl.textContent = '00';
        if (countdownContainer) countdownContainer.classList.add('addon-countdown--expired');
        return false;
      }

      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);

      if (daysEl) daysEl.textContent = String(days).padStart(2, '0');
      if (hoursEl) hoursEl.textContent = String(hours).padStart(2, '0');
      if (minutesEl) minutesEl.textContent = String(minutes).padStart(2, '0');
      if (secondsEl) secondsEl.textContent = String(seconds).padStart(2, '0');

      return true;
    }

    // Initial update
    if (updateCountdown()) {
      // Update every second
      setInterval(updateCountdown, 1000);
    }
  }

  /**
   * Initialize selections from pre-checked items and auto-select FREE_GIFT items
   */
  function initializeSelections() {
    // Auto-select all FREE_GIFT items (they are always included)
    // But skip sold-out FREE_GIFT items
    document.querySelectorAll('.addon-item--free-gift').forEach(addonItem => {
      // Skip sold-out free gifts
      if (addonItem.dataset.soldOut === 'true' || addonItem.dataset.allVariantsSoldOut === 'true') {
        console.log('[AddonBundle] Skipping sold-out FREE_GIFT:', addonItem.dataset.addonId);
        return;
      }
      updateSelectionState(addonItem, true);
      addonItem.classList.add('addon-item--selected');
      console.log('[AddonBundle] Auto-selected FREE_GIFT:', addonItem.dataset.addonId);
    });

    // Initialize regular pre-checked items
    document.querySelectorAll('.addon-item__input:checked').forEach(input => {
      const addonItem = input.closest('.addon-item');
      // Skip if it's a free gift (already handled above) or sold out
      if (addonItem && !addonItem.classList.contains('addon-item--free-gift')) {
        // Skip sold-out items
        if (addonItem.dataset.soldOut === 'true' || addonItem.dataset.allVariantsSoldOut === 'true') {
          input.checked = false;
          console.log('[AddonBundle] Unchecking sold-out pre-selected item:', addonItem.dataset.addonId);
          return;
        }
        updateSelectionState(addonItem, true);
      }
    });

    console.log('[AddonBundle] Initial selections:', state.selectedAddOns.size);
  }

  /**
   * Setup checkbox/radio listeners
   */
  function setupSelectionListeners() {
    document.querySelectorAll('.addon-item__input').forEach(input => {
      input.addEventListener('change', (e) => {
        const addonItem = e.target.closest('.addon-item');

        // Prevent selection of sold-out items
        if (addonItem?.dataset.soldOut === 'true' || addonItem?.dataset.allVariantsSoldOut === 'true') {
          e.target.checked = false;
          console.log('[AddonBundle] Prevented selection of sold-out item');
          return;
        }

        const isSelected = e.target.checked;

        // For radio buttons, clear other selections first
        if (e.target.type === 'radio') {
          document.querySelectorAll('.addon-item--selected').forEach(item => {
            item.classList.remove('addon-item--selected');
          });
          state.selectedAddOns.clear();
        }

        updateSelectionState(addonItem, isSelected);
        console.log('[AddonBundle] Selection updated:', {
          addonId: addonItem?.dataset.addonId,
          isSelected,
          totalSelected: state.selectedAddOns.size,
          selections: Array.from(state.selectedAddOns.values())
        });
      });
    });
  }

  /**
   * Update selection state
   */
  function updateSelectionState(addonItem, isSelected) {
    if (!addonItem) return;

    const addonId = addonItem.dataset.addonId;
    const variantSelect = addonItem.querySelector('.addon-item__variant-select');
    const quantityInput = addonItem.querySelector('.addon-item__quantity-input');

    // Try multiple sources for variant ID
    let variantId = null;

    // Source 1: Variant select dropdown
    if (variantSelect && variantSelect.value) {
      variantId = variantSelect.value;
    }
    // Source 2: data-variant-id attribute
    if (!variantId && addonItem.dataset.variantId) {
      variantId = addonItem.dataset.variantId;
    }
    // Source 3: First option in variant select
    if (!variantId && variantSelect) {
      const firstOption = variantSelect.querySelector('option');
      if (firstOption) variantId = firstOption.value;
    }
    // Source 4: Hidden input with variant info
    if (!variantId) {
      const hiddenInput = addonItem.querySelector('input[data-variant-id]');
      if (hiddenInput) variantId = hiddenInput.dataset.variantId;
    }
    // Source 5: Any data attribute containing variant
    if (!variantId) {
      const allData = addonItem.dataset;
      for (const key in allData) {
        if (key.toLowerCase().includes('variant') && allData[key]) {
          variantId = allData[key];
          break;
        }
      }
    }

    // Extract numeric ID
    variantId = extractNumericId(variantId);

    console.log('[AddonBundle] updateSelectionState:', {
      addonId,
      variantId,
      rawVariantId: addonItem.dataset.variantId,
      hasVariantSelect: !!variantSelect,
      isSelected
    });

    if (isSelected) {
      addonItem.classList.add('addon-item--selected');
      if (variantId) {
        state.selectedAddOns.set(addonId, {
          addonId,
          variantId,
          quantity: quantityInput ? parseInt(quantityInput.value) || 1 : 1,
        });
      } else {
        console.warn('[AddonBundle] WARNING: No variant ID found for addon:', addonId);
        console.warn('[AddonBundle] Element dataset:', addonItem.dataset);
        console.warn('[AddonBundle] Element HTML:', addonItem.outerHTML.substring(0, 500));
      }
    } else {
      addonItem.classList.remove('addon-item--selected');
      state.selectedAddOns.delete(addonId);
    }
  }

  /**
   * Setup variant select listeners
   */
  function setupVariantListeners() {
    document.querySelectorAll('.addon-item__variant-select').forEach(select => {
      select.addEventListener('change', (e) => {
        const addonId = e.target.dataset.addonId;
        const addonItem = e.target.closest('.addon-item');
        const selectedOption = e.target.options[e.target.selectedIndex];

        // Check if selected variant is sold out
        if (selectedOption?.dataset.soldOut === 'true' && state.showSoldOutLabel) {
          // Try to select an available variant instead
          const availableOption = Array.from(e.target.options).find(
            opt => opt.dataset.soldOut !== 'true' && !opt.disabled
          );
          if (availableOption) {
            e.target.value = availableOption.value;
            console.log('[AddonBundle] Auto-selected available variant instead of sold-out');
          } else {
            console.log('[AddonBundle] No available variants found');
          }
          return;
        }

        const selection = state.selectedAddOns.get(addonId);
        if (selection) {
          selection.variantId = extractNumericId(e.target.value);
        }

        // Update price display when variant changes
        const newPrice = selectedOption?.dataset.price;

        if (addonItem && newPrice) {
          updatePriceDisplay(addonItem, parseFloat(newPrice));
        }
      });
    });
  }

  /**
   * Update price display for an addon item
   * @param {Element} addonItem - The addon item element
   * @param {number} originalPrice - Price in dollars (not cents)
   */
  function updatePriceDisplay(addonItem, originalPrice) {
    const priceRow = addonItem.querySelector('.addon-item__price-row');
    if (!priceRow) return;

    const input = addonItem.querySelector('.addon-item__input');
    const discountType = input?.dataset.discountType;
    const discountValue = parseFloat(input?.dataset.discountValue) || 0;

    let discountedPrice = originalPrice;
    let hasDiscount = false;

    switch (discountType) {
      case 'PERCENTAGE':
        if (discountValue > 0) {
          discountedPrice = originalPrice - (originalPrice * discountValue / 100);
          hasDiscount = true;
        }
        break;
      case 'FIXED_AMOUNT':
        if (discountValue > 0) {
          discountedPrice = Math.max(0, originalPrice - discountValue);
          hasDiscount = true;
        }
        break;
      case 'FIXED_PRICE':
        discountedPrice = discountValue;
        hasDiscount = true;
        break;
      case 'FREE_GIFT':
        discountedPrice = 0;
        hasDiscount = true;
        break;
    }

    // Update data attributes
    addonItem.dataset.originalPrice = originalPrice;
    addonItem.dataset.discountedPrice = discountedPrice;

    // Format prices (convert to cents for formatMoney)
    const formattedOriginal = formatMoney(originalPrice * 100);
    const formattedDiscounted = discountedPrice === 0 ? 'FREE' : formatMoney(discountedPrice * 100);

    if (hasDiscount) {
      priceRow.innerHTML = `
        <span class="addon-item__price addon-item__price--original">${formattedOriginal}</span>
        <span class="addon-item__price addon-item__price--discounted">${formattedDiscounted}</span>
      `;
    } else {
      priceRow.innerHTML = `
        <span class="addon-item__price">${formattedOriginal}</span>
      `;
    }
  }

  /**
   * Setup quantity listeners
   */
  function setupQuantityListeners() {
    document.querySelectorAll('.addon-item__quantity-input').forEach(input => {
      input.addEventListener('change', (e) => {
        const addonItem = e.target.closest('.addon-item');
        const addonId = addonItem?.dataset.addonId;
        const selection = state.selectedAddOns.get(addonId);
        if (selection) {
          selection.quantity = Math.max(1, parseInt(e.target.value) || 1);
        }
      });
    });
  }

  /**
   * Override add to cart - the main function to intercept cart additions
   */
  function overrideAddToCart() {
    // Method 1: Override fetch to intercept AJAX cart requests
    const originalFetch = window.fetch;
    window.fetch = async function(url, options) {
      const urlStr = typeof url === 'string' ? url : url.toString();

      // Skip if this is our own internal request (prevents double-adding)
      if (state.isInternalRequest) {
        return originalFetch.apply(this, arguments);
      }

      // Intercept cart/add requests (always intercept if there are add-ons, including free gifts)
      if (urlStr.includes('/cart/add') && (state.selectedAddOns.size > 0 || hasFreeGiftAddons())) {
        console.log('[AddonBundle] Intercepting fetch to /cart/add');
        return handleCartAddIntercept(url, options, originalFetch);
      }

      return originalFetch.apply(this, arguments);
    };

    // Method 2: Override XMLHttpRequest for older themes
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url) {
      this._addonBundleUrl = url;
      return originalXHROpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function(body) {
      if (this._addonBundleUrl &&
          this._addonBundleUrl.includes('/cart/add') &&
          (state.selectedAddOns.size > 0 || hasFreeGiftAddons())) {
        console.log('[AddonBundle] Intercepting XHR to /cart/add');
        // Add our items to the request
        handleXHRCartAdd(this, body, originalXHRSend);
        return;
      }
      return originalXHRSend.apply(this, arguments);
    };

    // Method 3: Intercept form submissions
    document.addEventListener('submit', handleFormSubmit, true);

    // Method 4: Intercept button clicks
    document.addEventListener('click', handleButtonClick, true);

    console.log('[AddonBundle] Add to cart override installed');
  }

  /**
   * Handle fetch interception for cart/add
   */
  async function handleCartAddIntercept(url, options, originalFetch) {
    try {
      let body = options?.body;
      let items = [];
      let mainItem = null;

      // Parse the original request body
      if (body) {
        if (typeof body === 'string') {
          try {
            const parsed = JSON.parse(body);
            if (parsed.items) {
              items = parsed.items;
            } else if (parsed.id) {
              mainItem = { id: parsed.id, quantity: parsed.quantity || 1 };
            }
          } catch (e) {
            // Might be form data
            const params = new URLSearchParams(body);
            mainItem = {
              id: params.get('id'),
              quantity: parseInt(params.get('quantity')) || 1
            };
          }
        } else if (body instanceof FormData) {
          mainItem = {
            id: body.get('id'),
            quantity: parseInt(body.get('quantity')) || 1
          };
        }
      }

      // Generate unique bundle group ID for this add-to-cart action
      const bundleGroupId = generateBundleGroupId();

      // Common bundle properties for tracking
      const bundleProperties = {
        _bundle_group_id: bundleGroupId,
        _bundle_id: state.bundleId
      };

      // Build combined items array
      const allItems = [];

      // Get main product variant ID for nested cart lines
      let mainVariantId = null;

      // Add main product with bundle properties
      if (mainItem && mainItem.id) {
        mainVariantId = parseInt(extractNumericId(mainItem.id));
        allItems.push({
          id: mainVariantId,
          quantity: mainItem.quantity,
          properties: {
            ...bundleProperties,
            _bundle_role: 'main'
          }
        });
      } else if (items.length > 0) {
        // If multiple items were in original request, mark the first as main
        mainVariantId = parseInt(extractNumericId(items[0].id));
        items.forEach((item, index) => {
          allItems.push({
            id: parseInt(extractNumericId(item.id)),
            quantity: item.quantity || 1,
            properties: index === 0 ? {
              ...bundleProperties,
              _bundle_role: 'main'
            } : item.properties
          });
        });
      }

      // Add selected add-ons as NESTED CART LINES (children of main product)
      // When deleteAddonsOnMainDelete is true, use parent_id to create nested relationship
      // Shopify will automatically remove children when parent is removed
      state.selectedAddOns.forEach(selection => {
        if (selection.variantId) {
          const addonItem = {
            id: parseInt(selection.variantId),
            quantity: selection.quantity || 1,
            properties: {
              ...bundleProperties,
              _bundle_role: 'addon',
              _addon_bundle_id: state.bundleId,
              _addon_main_product: state.productId
            }
          };

          // If deleteAddonsOnMainDelete is enabled, create nested cart line
          // by specifying parent_id (Shopify will auto-remove when parent is removed)
          if (state.deleteAddonsOnMainDelete && mainVariantId) {
            addonItem.parent_id = mainVariantId;
          }

          allItems.push(addonItem);
        }
      });

      console.log('[AddonBundle] Adding items to cart:', allItems);

      // Make the actual cart request with all items
      // Set flag to prevent re-interception
      state.isInternalRequest = true;
      try {
        const response = await originalFetch('/cart/add.js', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ items: allItems })
        });

        if (response.ok) {
          console.log('[AddonBundle] Successfully added all items to cart');
          const freeGiftCount = document.querySelectorAll('.addon-item--free-gift').length;
          const regularCount = state.selectedAddOns.size - freeGiftCount;
          let message = 'Added to cart';
          if (freeGiftCount > 0 && regularCount > 0) {
            message += ` with ${regularCount} add-on(s) + ${freeGiftCount} free gift(s)!`;
          } else if (freeGiftCount > 0) {
            message += ` with ${freeGiftCount} free gift(s)!`;
          } else if (regularCount > 0) {
            message += ` with ${regularCount} add-on(s)!`;
          } else {
            message += '!';
          }
          showNotification(message);
          refreshCartUI();
        }

        return response;
      } finally {
        state.isInternalRequest = false;
      }
    } catch (error) {
      console.error('[AddonBundle] Error intercepting cart add:', error);
      return originalFetch(url, options);
    }
  }

  /**
   * Handle XHR cart add interception
   */
  function handleXHRCartAdd(xhr, body, originalSend) {
    // Generate unique bundle group ID for this add-to-cart action
    const bundleGroupId = generateBundleGroupId();

    // Common bundle properties for tracking
    const bundleProperties = {
      _bundle_group_id: bundleGroupId,
      _bundle_id: state.bundleId
    };

    // Parse original body
    let mainItem = null;

    if (body) {
      if (typeof body === 'string') {
        try {
          const parsed = JSON.parse(body);
          if (parsed.id) {
            mainItem = { id: parsed.id, quantity: parsed.quantity || 1 };
          }
        } catch (e) {
          const params = new URLSearchParams(body);
          mainItem = {
            id: params.get('id'),
            quantity: parseInt(params.get('quantity')) || 1
          };
        }
      } else if (body instanceof FormData) {
        mainItem = {
          id: body.get('id'),
          quantity: parseInt(body.get('quantity')) || 1
        };
      }
    }

    // Build items array
    const items = [];

    // Get main product variant ID for nested cart lines
    let mainVariantId = null;

    // Add main product with bundle properties
    if (mainItem && mainItem.id) {
      mainVariantId = parseInt(extractNumericId(mainItem.id));
      items.push({
        id: mainVariantId,
        quantity: mainItem.quantity,
        properties: {
          ...bundleProperties,
          _bundle_role: 'main'
        }
      });
    }

    // Add addons as NESTED CART LINES (children of main product)
    // When deleteAddonsOnMainDelete is true, use parent_id to create nested relationship
    state.selectedAddOns.forEach(selection => {
      if (selection.variantId) {
        const addonItem = {
          id: parseInt(selection.variantId),
          quantity: selection.quantity || 1,
          properties: {
            ...bundleProperties,
            _bundle_role: 'addon',
            _addon_bundle_id: state.bundleId,
            _addon_main_product: state.productId
          }
        };

        // If deleteAddonsOnMainDelete is enabled, create nested cart line
        if (state.deleteAddonsOnMainDelete && mainVariantId) {
          addonItem.parent_id = mainVariantId;
        }

        items.push(addonItem);
      }
    });

    console.log('[AddonBundle] XHR adding items:', items);

    // Send modified request
    xhr.setRequestHeader('Content-Type', 'application/json');
    originalSend.call(xhr, JSON.stringify({ items }));

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        showNotification(`Added to cart with ${state.selectedAddOns.size} add-on(s)!`);
        refreshCartUI();
      }
    });
  }

  /**
   * Check if there are any FREE_GIFT add-ons on the page
   */
  function hasFreeGiftAddons() {
    return document.querySelectorAll('.addon-item--free-gift').length > 0;
  }

  /**
   * Handle form submit
   */
  function handleFormSubmit(e) {
    const form = e.target;
    if (!form.matches || !form.matches('form[action*="/cart/add"]')) return;
    if (state.selectedAddOns.size === 0 && !hasFreeGiftAddons()) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    console.log('[AddonBundle] Form submit intercepted');

    const formData = new FormData(form);
    const mainVariantId = extractNumericId(formData.get('id'));
    const mainQuantity = parseInt(formData.get('quantity')) || 1;

    if (!mainVariantId) {
      console.error('[AddonBundle] No variant ID found in form');
      form.submit();
      return;
    }

    addAllItemsToCart(mainVariantId, mainQuantity);
  }

  /**
   * Handle button click - for themes using JS to add to cart
   */
  function handleButtonClick(e) {
    const button = e.target.closest('button[type="submit"], button[name="add"], .add-to-cart, [data-add-to-cart]');
    if (!button) return;

    const form = button.closest('form[action*="/cart/add"]');
    if (!form) return;
    if (state.selectedAddOns.size === 0 && !hasFreeGiftAddons()) return;

    // Check if this is the add to cart button
    const isAddToCart = button.matches('[type="submit"]') ||
                        button.matches('[name="add"]') ||
                        button.classList.contains('add-to-cart') ||
                        button.hasAttribute('data-add-to-cart');

    if (!isAddToCart) return;

    console.log('[AddonBundle] Add to cart button clicked');

    // Don't prevent if it will be handled by form submit
    // The fetch/XHR override will handle the actual request
  }

  /**
   * Add main product and add-ons to cart
   */
  async function addAllItemsToCart(mainVariantId, mainQuantity) {
    // Generate unique bundle group ID for this add-to-cart action
    const bundleGroupId = generateBundleGroupId();

    // Common bundle properties for tracking
    const bundleProperties = {
      _bundle_group_id: bundleGroupId,
      _bundle_id: state.bundleId
    };

    // Parse main variant ID
    const parsedMainVariantId = parseInt(mainVariantId);

    // Add main product with bundle properties
    const items = [{
      id: parsedMainVariantId,
      quantity: mainQuantity,
      properties: {
        ...bundleProperties,
        _bundle_role: 'main'
      }
    }];

    // Add addons as NESTED CART LINES (children of main product)
    // When deleteAddonsOnMainDelete is true, use parent_id to create nested relationship
    state.selectedAddOns.forEach(selection => {
      if (selection.variantId) {
        const addonItem = {
          id: parseInt(selection.variantId),
          quantity: selection.quantity || 1,
          properties: {
            ...bundleProperties,
            _bundle_role: 'addon',
            _addon_bundle_id: state.bundleId,
            _addon_main_product: state.productId
          }
        };

        // If deleteAddonsOnMainDelete is enabled, create nested cart line
        if (state.deleteAddonsOnMainDelete && parsedMainVariantId) {
          addonItem.parent_id = parsedMainVariantId;
        }

        items.push(addonItem);
      }
    });

    console.log('[AddonBundle] Adding all items:', items);

    // Set flag to prevent re-interception
    state.isInternalRequest = true;
    try {
      const response = await fetch('/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items })
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('[AddonBundle] Cart API error:', error);
        throw new Error(error);
      }

      const result = await response.json();
      console.log('[AddonBundle] Cart add result:', result);

      showNotification(`Added to cart with ${state.selectedAddOns.size} add-on(s)!`);
      refreshCartUI();

      // Check if should redirect to cart
      const form = document.querySelector('form[action*="/cart/add"]');
      if (form && (form.action.includes('checkout') || form.dataset.redirectToCart)) {
        window.location.href = '/cart';
      }
    } catch (error) {
      console.error('[AddonBundle] Failed to add items:', error);
      showNotification('Failed to add items to cart', true);
    } finally {
      state.isInternalRequest = false;
    }
  }

  /**
   * Show notification
   */
  function showNotification(message, isError = false) {
    // Remove existing notification
    document.querySelector('.addon-bundle-notification')?.remove();

    const notification = document.createElement('div');
    notification.className = 'addon-bundle-notification';
    notification.textContent = message;
    notification.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: ${isError ? '#e74c3c' : '#27ae60'};
      color: white;
      padding: 16px 24px;
      border-radius: 8px;
      z-index: 99999;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 14px;
      font-weight: 500;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    `;

    document.body.appendChild(notification);
    setTimeout(() => notification.remove(), 4000);
  }

  /**
   * Refresh cart UI
   */
  function refreshCartUI() {
    fetch('/cart.js')
      .then(res => res.json())
      .then(cart => {
        // Update cart count badges
        document.querySelectorAll('.cart-count, .cart-item-count, [data-cart-count], .cart-count-bubble')
          .forEach(el => el.textContent = cart.item_count);

        // Dispatch events for theme cart drawers
        document.dispatchEvent(new CustomEvent('cart:refresh'));
        document.dispatchEvent(new CustomEvent('cart:updated', { detail: cart }));

        // For Dawn theme
        document.body.dispatchEvent(new CustomEvent('cart:change', {
          bubbles: true,
          detail: { cart }
        }));
      })
      .catch(console.error);
  }

  // ============================================
  // CART MONITORING - Auto-remove orphaned add-ons
  // ============================================

  let cartMonitoringEnabled = false;
  let lastKnownCart = null;
  let isProcessingRemoval = false;

  /**
   * Initialize cart monitoring to detect when main products are removed
   * and automatically remove their associated add-ons
   */
  function initCartMonitoring() {
    if (cartMonitoringEnabled) return;
    cartMonitoringEnabled = true;

    console.log('[AddonBundle] Cart monitoring initialized');

    // Get initial cart state
    fetchCartState();

    // Listen for various cart update events
    document.addEventListener('cart:refresh', handleCartChange);
    document.addEventListener('cart:updated', handleCartChange);
    document.addEventListener('cart:change', handleCartChange);

    // Override cart change/update requests to detect removals
    overrideCartChangeRequests();

    // Also poll periodically as a fallback (every 3 seconds when on cart page)
    if (window.location.pathname.includes('/cart')) {
      setInterval(fetchCartState, 3000);
    }
  }

  /**
   * Override fetch to intercept cart change requests
   */
  function overrideCartChangeRequests() {
    const originalFetch = window.fetch;

    window.fetch = async function(url, options = {}) {
      const response = await originalFetch.apply(this, arguments);

      // Check if this was a cart update or change request
      const urlStr = typeof url === 'string' ? url : url?.url || '';
      if (urlStr.includes('/cart/change') || urlStr.includes('/cart/update')) {
        // After cart change, check for orphaned add-ons
        setTimeout(() => {
          if (!isProcessingRemoval) {
            checkForOrphanedAddons();
          }
        }, 500);
      }

      return response;
    };
  }

  /**
   * Fetch current cart state
   */
  async function fetchCartState() {
    try {
      const response = await fetch('/cart.js');
      if (!response.ok) return;

      const cart = await response.json();
      const previousCart = lastKnownCart;
      lastKnownCart = cart;

      // If this isn't the initial load, check for removed items
      if (previousCart && !isProcessingRemoval) {
        checkForOrphanedAddons();
      }
    } catch (error) {
      console.error('[AddonBundle] Error fetching cart:', error);
    }
  }

  /**
   * Handle cart change events
   */
  function handleCartChange(event) {
    if (isProcessingRemoval) return;

    // Update cart state if provided in event
    if (event.detail?.cart) {
      lastKnownCart = event.detail.cart;
    }

    // Check for orphaned add-ons after a short delay
    setTimeout(checkForOrphanedAddons, 300);
  }

  /**
   * Check if any add-ons are orphaned (main product removed)
   * and remove them if deleteAddonsOnMainDelete is true
   */
  async function checkForOrphanedAddons() {
    if (isProcessingRemoval) return;

    try {
      // Fetch fresh cart data
      const response = await fetch('/cart.js');
      if (!response.ok) return;

      const cart = await response.json();

      // Group items by bundle_group_id
      const bundleGroups = new Map();

      cart.items.forEach((item, index) => {
        const groupId = item.properties?._bundle_group_id;
        const role = item.properties?._bundle_role;
        const deleteFlag = item.properties?._delete_addons_on_main_delete;

        if (!groupId || !role) return;

        if (!bundleGroups.has(groupId)) {
          bundleGroups.set(groupId, {
            groupId,
            deleteAddonsOnMainDelete: deleteFlag === 'true',
            mainItem: null,
            addonItems: []
          });
        }

        const group = bundleGroups.get(groupId);

        if (role === 'main') {
          group.mainItem = { ...item, lineIndex: index + 1, key: item.key };
        } else if (role === 'addon') {
          group.addonItems.push({ ...item, lineIndex: index + 1, key: item.key });
        }

        // Use the flag from any item in the group
        if (deleteFlag === 'true') {
          group.deleteAddonsOnMainDelete = true;
        }
      });

      // Find orphaned add-ons (add-ons without their main product)
      const addonsToRemove = [];

      bundleGroups.forEach((group, groupId) => {
        // If main product is missing and flag is true, remove addons
        if (!group.mainItem && group.deleteAddonsOnMainDelete && group.addonItems.length > 0) {
          console.log('[AddonBundle] Orphaned add-ons detected for group:', groupId);
          group.addonItems.forEach(addon => {
            addonsToRemove.push(addon);
          });
        }
      });

      // Remove orphaned add-ons
      if (addonsToRemove.length > 0) {
        await removeOrphanedAddons(addonsToRemove);
      }
    } catch (error) {
      console.error('[AddonBundle] Error checking for orphaned add-ons:', error);
    }
  }

  /**
   * Remove orphaned add-ons from the cart
   */
  async function removeOrphanedAddons(addons) {
    if (addons.length === 0) return;

    isProcessingRemoval = true;
    console.log('[AddonBundle] Removing', addons.length, 'orphaned add-on(s)');

    try {
      // Build updates object to set quantities to 0
      const updates = {};
      addons.forEach(addon => {
        // Use the item key for accurate targeting
        if (addon.key) {
          updates[addon.key] = 0;
        }
      });

      // Make the cart update request
      const response = await fetch('/cart/update.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates })
      });

      if (response.ok) {
        console.log('[AddonBundle] Successfully removed orphaned add-ons');

        // Show notification
        const message = addons.length === 1
          ? 'Add-on removed (main product was removed)'
          : `${addons.length} add-ons removed (main product was removed)`;
        showNotification(message);

        // Refresh cart UI
        refreshCartUI();
      } else {
        console.error('[AddonBundle] Failed to remove add-ons:', await response.text());
      }
    } catch (error) {
      console.error('[AddonBundle] Error removing add-ons:', error);
    } finally {
      isProcessingRemoval = false;
    }
  }

  // Public API
  window.AddonBundle = {
    getSelectedAddOns: () => Array.from(state.selectedAddOns.values()),
    getBundleId: () => state.bundleId,
    getState: () => ({ ...state }),
    addToCart: addAllItemsToCart,
    checkOrphanedAddons: checkForOrphanedAddons,
    isCartMonitoringEnabled: () => cartMonitoringEnabled,
  };

  /**
   * Initialize cart monitoring globally (runs on all pages)
   * This ensures add-ons are removed even when main product is deleted from cart page
   */
  function initGlobalCartMonitoring() {
    // Always start cart monitoring, even without the widget
    // This ensures orphaned add-ons are cleaned up on cart page
    if (!cartMonitoringEnabled) {
      cartMonitoringEnabled = true;
      console.log('[AddonBundle] Global cart monitoring initialized');

      // Get initial cart state
      fetchCartState();

      // Listen for various cart update events
      document.addEventListener('cart:refresh', handleCartChange);
      document.addEventListener('cart:updated', handleCartChange);
      document.addEventListener('cart:change', handleCartChange);

      // Override cart change/update requests
      overrideCartChangeRequests();

      // Poll more frequently on cart page
      if (window.location.pathname.includes('/cart')) {
        setInterval(fetchCartState, 2000);
      }
    }
  }

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      init();
      // Always init global cart monitoring
      initGlobalCartMonitoring();
    });
  } else {
    init();
    initGlobalCartMonitoring();
  }

  // Fallback initialization
  setTimeout(() => {
    init();
    initGlobalCartMonitoring();
  }, 500);
})();
