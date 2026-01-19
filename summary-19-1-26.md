# Claude Project Memory - Add-On Bundle App

## Project Overview
A Shopify app that allows merchants to create add-on product bundles with discounts. Customers see add-ons on product pages and can add them to cart with automatic discount application.

## Tech Stack
- **Frontend**: React + React Router (Remix-style)
- **Backend**: Node.js with React Router server
- **Database**: SQLite via Prisma ORM
- **Shopify Integration**: App Bridge, Admin GraphQL API
- **Extensions**: Shopify Functions (discounts), Theme App Extension (widget)

## Project Structure
```
claude-addon-bundle-app/
├── app/
│   ├── db.server.ts              # Prisma client
│   ├── shopify.server.ts         # Shopify auth
│   ├── models/                   # Database operations
│   │   ├── bundle.server.ts      # Bundle CRUD
│   │   ├── addOnSet.server.ts    # Add-on products
│   │   ├── targeting.server.ts   # Product targeting
│   │   ├── widgetStyle.server.ts # Widget styling
│   │   └── shopSettings.server.ts# App settings
│   ├── routes/
│   │   ├── app.bundles._index.tsx  # Bundle list
│   │   ├── app.bundles.new.tsx     # Create bundle
│   │   ├── app.bundles.$id.tsx     # Edit bundle (main file ~1800 lines)
│   │   └── app.settings.tsx        # App settings + debug
│   ├── services/
│   │   ├── discount.sync.ts      # Shopify discount management
│   │   └── metafield.sync.ts     # Metafield syncing
│   └── types/                    # TypeScript types
├── extensions/
│   ├── addon-bundle-discount/    # Discount function (WASM)
│   │   └── src/cart_lines_discounts_generate_run.ts
│   └── addon-bundle-widget/      # Theme extension
│       ├── blocks/addon-bundle.liquid
│       ├── snippets/addon-*.liquid
│       └── assets/addon-bundle.{css,js}
├── prisma/schema.prisma          # Database schema
└── shopify.app.toml              # App config
```

## Database Schema (Key Models)

### Bundle
Main entity - represents a complete add-on bundle
```prisma
model Bundle {
  id                String   @id @default(uuid())
  shop              String
  title             String
  subtitle          String?
  status            BundleStatus  // DRAFT | ACTIVE | ARCHIVED
  startDate         DateTime?
  endDate           DateTime?
  selectionMode     SelectionMode // SINGLE | MULTIPLE
  targetingType     TargetingType // ALL_PRODUCTS | SPECIFIC_PRODUCTS | PRODUCT_GROUPS
  combineWithProductDiscounts   DiscountCombination // COMBINE | NOT_COMBINE
  combineWithOrderDiscounts     DiscountCombination
  combineWithShippingDiscounts  DiscountCombination
  shopifyDiscountId String?       // Reference to Shopify automatic discount

  addOnSets         AddOnSet[]
  targetedItems     BundleTargetedItem[]
  productGroups     ProductGroup[]
  widgetStyle       WidgetStyle?
}
```

### AddOnSet
Individual product added as an add-on
```prisma
model AddOnSet {
  id                String   @id @default(uuid())
  bundleId          String
  shopifyProductId  String
  productTitle      String?
  productImageUrl   String?
  discountType      DiscountType  // PERCENTAGE | FIXED_AMOUNT | FIXED_PRICE | FREE_GIFT
  discountValue     Decimal?
  discountLabel     String?
  isDefaultSelected Boolean @default(false)
  subscriptionOnly  Boolean @default(false)
  showQuantitySelector Boolean @default(false)
  maxQuantity       Int @default(10)

  selectedVariants  AddOnSetVariant[]
}
```

### AddOnSetVariant
Specific variants in an add-on
```prisma
model AddOnSetVariant {
  id               String @id @default(uuid())
  addOnSetId       String
  shopifyVariantId String
  variantTitle     String?
  variantPrice     Decimal?
}
```

### BundleTargetedItem
Products/collections for SPECIFIC_PRODUCTS targeting
```prisma
model BundleTargetedItem {
  id                  String @id @default(uuid())
  bundleId            String
  shopifyResourceId   String  // Product or Collection GID
  shopifyResourceType String  // "Product" | "Collection"
}
```

### WidgetStyle
Visual customization for the widget
- Colors: backgroundColor, fontColor, buttonColor, buttonTextColor, discountBadgeColor, discountTextColor, borderColor
- Typography: fontSize, titleFontSize, subtitleFontSize
- Layout: layoutType (GRID|LIST), borderRadius, borderStyle, borderWidth, padding, marginTop, marginBottom, imageSize

## Key Services

### metafield.sync.ts
- `buildWidgetConfig(bundle, addOnSets, widgetStyle)` - Creates config for theme widget
- `buildDiscountConfig(bundle, addOnSets)` - Creates config for discount function
- `syncShopMetafields(admin, shopGid, config)` - Sync to shop metafield (ALL_PRODUCTS)
- `syncProductMetafields(admin, productIds, config)` - Sync to product metafields (SPECIFIC_PRODUCTS)
- `clearShopMetafield(admin, shopGid)` - Clear shop metafield
- `clearProductMetafields(admin, productIds)` - Clear product metafields

### discount.sync.ts
- `activateBundleDiscount(admin, shop, bundle)` - Create/activate Shopify automatic discount
- `deactivateBundleDiscount(admin, shop, bundle)` - Deactivate discount
- `updateBundleDiscount(admin, bundle)` - Update discount metafield config
- `getFunctionId(admin)` - Find discount function ID by searching app functions

## Route Actions (app.bundles.$id.tsx)
The edit bundle page handles multiple intents:
- `updateBundle` - Save bundle settings
- `deleteBundle` - Delete bundle + cleanup metafields + discount
- `createAddOnSet` - Add product as add-on (uses variants from picker)
- `updateAddOnSet` - Update add-on discount/settings
- `deleteAddOnSet` - Remove add-on
- `updateAddOnSetVariants` - Edit which variants are included
- `updateStyle` - Update widget styling
- `resetStyle` - Reset to defaults
- `addTargetedItem` / `removeTargetedItem` - Manage SPECIFIC_PRODUCTS targeting
- `createProductGroup` / `deleteProductGroup` - Manage tabs
- `addProductGroupItem` / `removeProductGroupItem` - Products in groups
- `syncMetafields` - Manual sync (Force Sync button)

## Metafield Structure

### Shop Metafield (ALL_PRODUCTS)
- Namespace: `addon-bundle`
- Key: `global_config`
- Contains: Widget config JSON for all products

### Product Metafield (SPECIFIC_PRODUCTS)
- Namespace: `addon-bundle`
- Key: `config`
- Contains: Widget config JSON for specific product

### Discount Metafield
- Stored on the Shopify automatic discount
- Contains: Discount function config with add-on variant mappings

## Discount Function Logic
Location: `extensions/addon-bundle-discount/src/cart_lines_discounts_generate_run.ts`

1. Reads bundle config from discount metafield
2. Creates variant ID -> add-on config map
3. For each cart line:
   - Check if variant ID matches any add-on
   - Check for `_addon_bundle_id` attribute
   - Apply discount based on type:
     - PERCENTAGE: `(price * discountValue) / 100` off
     - FIXED_AMOUNT: `discountValue` off per item
     - FIXED_PRICE: Calculate discount to reach target price
     - FREE_GIFT: 100% off
4. Returns ProductDiscountCandidate operations

## Theme Widget
Location: `extensions/addon-bundle-widget/`

- `blocks/addon-bundle.liquid` - Main block, reads metafield config
- Displays add-ons based on selectionMode (radio for SINGLE, checkbox for MULTIPLE)
- `assets/addon-bundle.js` - Handles add-to-cart with `_addon_bundle_id` attribute
- Supports grid/list layouts, customizable colors, fonts, spacing

## Common Issues Fixed

1. **MetafieldIdentifierInput requires ownerId/namespace/key** - NOT `id`
   - Use: `{ ownerId: shopGid, namespace: "addon-bundle", key: "config" }`

2. **Prisma Decimal doesn't serialize to JSON** - Convert with `Number()`
   ```typescript
   discountValue: addOn.discountValue ? Number(addOn.discountValue) : null
   ```

3. **Button refs in conditional tabs** - Add `activeTab` to useEffect dependencies
   ```typescript
   useEffect(() => { ... }, [openProductPicker, activeTab]);
   ```

4. **Server-side redirect for embedded apps** - Use `throw redirect()` not `navigate()`

5. **Sync both widget AND discount metafields** - Changes need to update both

## App Configuration (shopify.app.toml)
```toml
[access_scopes]
scopes = "write_products,read_products,write_discounts,read_discounts"

[access_scopes.metafields]
allow = ["addon-bundle/config", "addon-bundle/global_config"]

[webhooks]
api_version = "2026-04"
# Subscribed: app/uninstalled, products/update, products/delete, collections/update, collections/delete
```

## Data Flow Summary

1. **Admin creates bundle** -> Saved to database
2. **Admin activates bundle** -> Creates Shopify discount + syncs metafields
3. **Admin adds add-ons** -> Syncs to discount metafield + widget metafield
4. **Customer views product** -> Widget reads metafield, displays add-ons
5. **Customer selects add-on** -> Added to cart with `_addon_bundle_id` attribute
6. **Checkout** -> Discount function reads config, applies discounts to matching items

## Key Files to Edit

- **Bundle logic**: `app/routes/app.bundles.$id.tsx` (~1800 lines)
- **Metafield sync**: `app/services/metafield.sync.ts`
- **Discount sync**: `app/services/discount.sync.ts`
- **Discount function**: `extensions/addon-bundle-discount/src/cart_lines_discounts_generate_run.ts`
- **Widget display**: `extensions/addon-bundle-widget/blocks/addon-bundle.liquid`
- **Database schema**: `prisma/schema.prisma`
