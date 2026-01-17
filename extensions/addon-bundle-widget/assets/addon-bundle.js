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
    initialized: false,
    isInternalRequest: false, // Flag to prevent double-interception
  };

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
    state.initialized = true;

    console.log('[AddonBundle] Widget initialized', { bundleId: state.bundleId });

    // Setup all listeners
    setupSelectionListeners();
    setupVariantListeners();
    setupQuantityListeners();
    initializeSelections();

    // CRITICAL: Override the add to cart behavior
    overrideAddToCart();
  }

  /**
   * Initialize selections from pre-checked items
   */
  function initializeSelections() {
    document.querySelectorAll('.addon-item__input:checked').forEach(input => {
      const addonItem = input.closest('.addon-item');
      if (addonItem) updateSelectionState(addonItem, true);
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
        const selection = state.selectedAddOns.get(addonId);
        if (selection) {
          selection.variantId = extractNumericId(e.target.value);
        }
      });
    });
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

      // Intercept cart/add requests
      if (urlStr.includes('/cart/add') && state.selectedAddOns.size > 0) {
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
          state.selectedAddOns.size > 0) {
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

      // Build combined items array
      const allItems = [];

      if (mainItem && mainItem.id) {
        allItems.push({
          id: parseInt(extractNumericId(mainItem.id)),
          quantity: mainItem.quantity
        });
      } else if (items.length > 0) {
        items.forEach(item => {
          allItems.push({
            id: parseInt(extractNumericId(item.id)),
            quantity: item.quantity || 1
          });
        });
      }

      // Add selected add-ons
      state.selectedAddOns.forEach(selection => {
        if (selection.variantId) {
          allItems.push({
            id: parseInt(selection.variantId),
            quantity: selection.quantity || 1,
            properties: {
              _addon_bundle_id: state.bundleId,
              _addon_main_product: state.productId
            }
          });
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
          showNotification(`Added to cart with ${state.selectedAddOns.size} add-on(s)!`);
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

    if (mainItem && mainItem.id) {
      items.push({
        id: parseInt(extractNumericId(mainItem.id)),
        quantity: mainItem.quantity
      });
    }

    state.selectedAddOns.forEach(selection => {
      if (selection.variantId) {
        items.push({
          id: parseInt(selection.variantId),
          quantity: selection.quantity || 1,
          properties: {
            _addon_bundle_id: state.bundleId,
            _addon_main_product: state.productId
          }
        });
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
   * Handle form submit
   */
  function handleFormSubmit(e) {
    const form = e.target;
    if (!form.matches || !form.matches('form[action*="/cart/add"]')) return;
    if (state.selectedAddOns.size === 0) return;

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
    if (state.selectedAddOns.size === 0) return;

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
    const items = [{
      id: parseInt(mainVariantId),
      quantity: mainQuantity
    }];

    state.selectedAddOns.forEach(selection => {
      if (selection.variantId) {
        items.push({
          id: parseInt(selection.variantId),
          quantity: selection.quantity || 1,
          properties: {
            _addon_bundle_id: state.bundleId,
            _addon_main_product: state.productId
          }
        });
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

  // Public API
  window.AddonBundle = {
    getSelectedAddOns: () => Array.from(state.selectedAddOns.values()),
    getBundleId: () => state.bundleId,
    getState: () => ({ ...state }),
    addToCart: addAllItemsToCart,
  };

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Fallback initialization
  setTimeout(init, 500);
})();
