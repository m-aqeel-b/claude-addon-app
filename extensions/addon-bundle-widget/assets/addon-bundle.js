/**
 * Add-On Bundle Widget JavaScript
 * Handles selection state, variant changes, quantity updates, and cart integration
 */

(function () {
  'use strict';

  // State
  const state = {
    selectedAddOns: new Map(),
    bundleId: null,
    productId: null,
  };

  /**
   * Initialize the widget
   */
  function init() {
    const widget = document.querySelector('.addon-bundle-widget');
    if (!widget) return;

    state.bundleId = widget.dataset.bundleId;
    state.productId = widget.dataset.productId;

    // Set up event listeners
    setupSelectionListeners();
    setupVariantListeners();
    setupQuantityListeners();
    setupTabListeners();
    interceptAddToCart();

    // Initialize selection state from pre-selected items
    initializeSelections();
  }

  /**
   * Initialize selections from pre-selected checkboxes
   */
  function initializeSelections() {
    const checkedInputs = document.querySelectorAll('.addon-item__input:checked');
    checkedInputs.forEach(input => {
      const addonItem = input.closest('.addon-item');
      updateSelectionState(addonItem, true);
    });
  }

  /**
   * Setup checkbox/radio selection listeners
   */
  function setupSelectionListeners() {
    const inputs = document.querySelectorAll('.addon-item__input');
    inputs.forEach(input => {
      input.addEventListener('change', (e) => {
        const addonItem = e.target.closest('.addon-item');
        const isSelected = e.target.checked;

        // For radio buttons, deselect all others first
        if (e.target.type === 'radio') {
          document.querySelectorAll('.addon-item--selected').forEach(item => {
            item.classList.remove('addon-item--selected');
          });
          state.selectedAddOns.clear();
        }

        updateSelectionState(addonItem, isSelected);
      });
    });
  }

  /**
   * Update selection state for an add-on
   */
  function updateSelectionState(addonItem, isSelected) {
    const addonId = addonItem.dataset.addonId;
    const variantSelect = addonItem.querySelector('.addon-item__variant-select');
    const quantityInput = addonItem.querySelector('.addon-item__quantity-input');

    if (isSelected) {
      addonItem.classList.add('addon-item--selected');
      state.selectedAddOns.set(addonId, {
        addonId,
        variantId: variantSelect ? variantSelect.value : addonItem.dataset.variantId,
        quantity: quantityInput ? parseInt(quantityInput.value) : 1,
      });
    } else {
      addonItem.classList.remove('addon-item--selected');
      state.selectedAddOns.delete(addonId);
    }
  }

  /**
   * Setup variant selector listeners
   */
  function setupVariantListeners() {
    const selects = document.querySelectorAll('.addon-item__variant-select');
    selects.forEach(select => {
      select.addEventListener('change', (e) => {
        const addonId = e.target.dataset.addonId;
        const selection = state.selectedAddOns.get(addonId);
        if (selection) {
          selection.variantId = e.target.value;
        }
      });
    });
  }

  /**
   * Setup quantity input listeners
   */
  function setupQuantityListeners() {
    const inputs = document.querySelectorAll('.addon-item__quantity-input');
    inputs.forEach(input => {
      input.addEventListener('change', (e) => {
        const addonItem = e.target.closest('.addon-item');
        const addonId = addonItem.dataset.addonId;
        const selection = state.selectedAddOns.get(addonId);
        if (selection) {
          selection.quantity = Math.max(1, parseInt(e.target.value) || 1);
        }
      });
    });
  }

  /**
   * Setup tab navigation listeners
   */
  function setupTabListeners() {
    const tabs = document.querySelectorAll('.addon-tabs__tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', (e) => {
        const tabIndex = e.target.dataset.tabIndex;

        // Update tab states
        tabs.forEach(t => {
          t.classList.remove('addon-tabs__tab--active');
          t.setAttribute('aria-selected', 'false');
        });
        e.target.classList.add('addon-tabs__tab--active');
        e.target.setAttribute('aria-selected', 'true');

        // Update panel visibility
        const panels = document.querySelectorAll('.addon-tabs__panel');
        panels.forEach(panel => {
          panel.classList.remove('addon-tabs__panel--active');
          panel.hidden = true;
        });

        const activePanel = document.getElementById(`addon-panel-${tabIndex}`);
        if (activePanel) {
          activePanel.classList.add('addon-tabs__panel--active');
          activePanel.hidden = false;
        }
      });
    });
  }

  /**
   * Intercept add-to-cart to include selected add-ons
   */
  function interceptAddToCart() {
    // Find all add-to-cart forms
    const forms = document.querySelectorAll('form[action="/cart/add"]');

    forms.forEach(form => {
      form.addEventListener('submit', async (e) => {
        // Only intercept if we have selected add-ons
        if (state.selectedAddOns.size === 0) return;

        e.preventDefault();

        const widget = document.querySelector('.addon-bundle-widget');
        widget?.classList.add('addon-bundle-widget--loading');

        try {
          // Get the main product data from the form
          const formData = new FormData(form);
          const mainProductId = formData.get('id');
          const mainQuantity = parseInt(formData.get('quantity')) || 1;

          // Build items array for batch add
          const items = [
            {
              id: mainProductId,
              quantity: mainQuantity,
            },
          ];

          // Add selected add-ons
          state.selectedAddOns.forEach(selection => {
            items.push({
              id: selection.variantId,
              quantity: selection.quantity,
              properties: {
                _addon_bundle_id: state.bundleId,
                _addon_main_product: state.productId,
              },
            });
          });

          // Add all items to cart
          const response = await fetch('/cart/add.js', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ items }),
          });

          if (!response.ok) {
            throw new Error('Failed to add items to cart');
          }

          // Redirect to cart or trigger cart update
          if (form.dataset.redirectToCart === 'true') {
            window.location.href = '/cart';
          } else {
            // Trigger cart update event for themes that use AJAX cart
            document.dispatchEvent(new CustomEvent('cart:refresh'));

            // Show success feedback
            showSuccessMessage();
          }
        } catch (error) {
          console.error('Add-on bundle error:', error);
          // Fallback: submit form normally
          form.submit();
        } finally {
          widget?.classList.remove('addon-bundle-widget--loading');
        }
      });
    });
  }

  /**
   * Show success message after adding to cart
   */
  function showSuccessMessage() {
    // Check if the theme has a notification system
    if (typeof window.theme !== 'undefined' && window.theme.showNotification) {
      window.theme.showNotification('Added to cart!', 'success');
      return;
    }

    // Simple fallback notification
    const notification = document.createElement('div');
    notification.className = 'addon-bundle-notification';
    notification.textContent = 'Added to cart!';
    notification.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #27ae60;
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      z-index: 9999;
      animation: slideIn 0.3s ease;
    `;

    document.body.appendChild(notification);

    setTimeout(() => {
      notification.remove();
    }, 3000);
  }

  /**
   * Get current selection for external use
   */
  window.AddonBundle = {
    getSelectedAddOns: () => Array.from(state.selectedAddOns.values()),
    getBundleId: () => state.bundleId,
  };

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
