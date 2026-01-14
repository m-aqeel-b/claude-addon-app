import type {
  ShopSettings,
  SelectionMode,
  LayoutType,
  ImageSize,
} from "@prisma/client";
import prisma from "~/db.server";

// ============================================================================
// TYPES
// ============================================================================

export interface UpdateShopSettingsInput {
  defaultSelectionMode?: SelectionMode;
  defaultLayoutType?: LayoutType;
  defaultImageSize?: ImageSize;
  defaultBackgroundColor?: string;
  defaultFontColor?: string;
  defaultButtonColor?: string;
  defaultButtonTextColor?: string;
  analyticsEnabled?: boolean;
}

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get shop settings, creating default if not exists
 */
export async function getShopSettings(shop: string): Promise<ShopSettings> {
  let settings = await prisma.shopSettings.findUnique({
    where: { shop },
  });

  if (!settings) {
    settings = await prisma.shopSettings.create({
      data: { shop },
    });
  }

  return settings;
}

/**
 * Check if shop settings exist
 */
export async function shopSettingsExist(shop: string): Promise<boolean> {
  const count = await prisma.shopSettings.count({
    where: { shop },
  });
  return count > 0;
}

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Update shop settings
 */
export async function updateShopSettings(
  shop: string,
  input: UpdateShopSettingsInput
): Promise<ShopSettings> {
  return prisma.shopSettings.upsert({
    where: { shop },
    update: {
      ...input,
      updatedAt: new Date(),
    },
    create: {
      shop,
      ...input,
    },
  });
}

/**
 * Mark shop as uninstalled (called from webhook)
 */
export async function markShopUninstalled(shop: string): Promise<void> {
  await prisma.shopSettings.updateMany({
    where: { shop },
    data: { uninstalledAt: new Date() },
  });
}

/**
 * Mark shop as reinstalled (called on auth)
 */
export async function markShopReinstalled(shop: string): Promise<void> {
  await prisma.shopSettings.updateMany({
    where: { shop },
    data: { uninstalledAt: null },
  });
}

/**
 * Delete all shop data (called on GDPR shop redact)
 */
export async function deleteShopData(shop: string): Promise<void> {
  await prisma.$transaction([
    // Delete all bundles (cascades to related data)
    prisma.bundle.deleteMany({ where: { shop } }),
    // Delete shop settings
    prisma.shopSettings.deleteMany({ where: { shop } }),
    // Delete sessions
    prisma.session.deleteMany({ where: { shop } }),
  ]);
}
