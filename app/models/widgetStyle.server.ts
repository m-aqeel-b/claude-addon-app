import type {
  WidgetStyle,
  LayoutType,
  ImageSize,
  DiscountLabelStyle,
  BorderStyle,
  WidgetTemplate,
} from "@prisma/client";
import prisma from "~/db.server";

// ============================================================================
// TYPES
// ============================================================================

export interface UpdateWidgetStyleInput {
  backgroundColor?: string;
  fontColor?: string;
  buttonColor?: string;
  buttonTextColor?: string;
  discountBadgeColor?: string;
  discountTextColor?: string;
  fontSize?: number;
  titleFontSize?: number;
  subtitleFontSize?: number;
  layoutType?: LayoutType;
  borderRadius?: number;
  borderStyle?: BorderStyle;
  borderWidth?: number;
  borderColor?: string;
  padding?: number;
  marginTop?: number;
  marginBottom?: number;
  imageSize?: ImageSize;
  discountLabelStyle?: DiscountLabelStyle;
  template?: WidgetTemplate;
}

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get widget style for a bundle
 */
export async function getWidgetStyle(
  bundleId: string
): Promise<WidgetStyle | null> {
  return prisma.widgetStyle.findUnique({
    where: { bundleId },
  });
}

/**
 * Get widget style or create default
 */
export async function getOrCreateWidgetStyle(
  bundleId: string
): Promise<WidgetStyle> {
  let style = await prisma.widgetStyle.findUnique({
    where: { bundleId },
  });

  if (!style) {
    style = await prisma.widgetStyle.create({
      data: { bundleId },
    });
  }

  return style;
}

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Update widget style for a bundle
 */
export async function updateWidgetStyle(
  bundleId: string,
  input: UpdateWidgetStyleInput
): Promise<WidgetStyle> {
  return prisma.widgetStyle.upsert({
    where: { bundleId },
    update: {
      ...input,
      updatedAt: new Date(),
    },
    create: {
      bundleId,
      ...input,
    },
  });
}

/**
 * Reset widget style to defaults
 */
export async function resetWidgetStyle(bundleId: string): Promise<WidgetStyle> {
  return prisma.widgetStyle.update({
    where: { bundleId },
    data: {
      template: "DEFAULT",
      backgroundColor: "#ffffff",
      fontColor: "#000000",
      buttonColor: "#000000",
      buttonTextColor: "#ffffff",
      discountBadgeColor: "#e53935",
      discountTextColor: "#ffffff",
      fontSize: 14,
      titleFontSize: 18,
      subtitleFontSize: 14,
      layoutType: "LIST",
      borderRadius: 8,
      borderStyle: "SOLID",
      borderWidth: 1,
      borderColor: "#e0e0e0",
      padding: 16,
      marginTop: 16,
      marginBottom: 16,
      imageSize: "MEDIUM",
      discountLabelStyle: "BADGE",
      updatedAt: new Date(),
    },
  });
}

/**
 * Copy widget style from one bundle to another
 */
export async function copyWidgetStyle(
  fromBundleId: string,
  toBundleId: string
): Promise<WidgetStyle> {
  const source = await prisma.widgetStyle.findUnique({
    where: { bundleId: fromBundleId },
  });

  if (!source) {
    return prisma.widgetStyle.create({
      data: { bundleId: toBundleId },
    });
  }

  return prisma.widgetStyle.upsert({
    where: { bundleId: toBundleId },
    update: {
      backgroundColor: source.backgroundColor,
      fontColor: source.fontColor,
      buttonColor: source.buttonColor,
      buttonTextColor: source.buttonTextColor,
      discountBadgeColor: source.discountBadgeColor,
      discountTextColor: source.discountTextColor,
      fontSize: source.fontSize,
      titleFontSize: source.titleFontSize,
      subtitleFontSize: source.subtitleFontSize,
      layoutType: source.layoutType,
      borderRadius: source.borderRadius,
      borderStyle: source.borderStyle,
      borderWidth: source.borderWidth,
      borderColor: source.borderColor,
      padding: source.padding,
      marginTop: source.marginTop,
      marginBottom: source.marginBottom,
      imageSize: source.imageSize,
      discountLabelStyle: source.discountLabelStyle,
      updatedAt: new Date(),
    },
    create: {
      bundleId: toBundleId,
      backgroundColor: source.backgroundColor,
      fontColor: source.fontColor,
      buttonColor: source.buttonColor,
      buttonTextColor: source.buttonTextColor,
      discountBadgeColor: source.discountBadgeColor,
      discountTextColor: source.discountTextColor,
      fontSize: source.fontSize,
      titleFontSize: source.titleFontSize,
      subtitleFontSize: source.subtitleFontSize,
      layoutType: source.layoutType,
      borderRadius: source.borderRadius,
      borderStyle: source.borderStyle,
      borderWidth: source.borderWidth,
      borderColor: source.borderColor,
      padding: source.padding,
      marginTop: source.marginTop,
      marginBottom: source.marginBottom,
      imageSize: source.imageSize,
      discountLabelStyle: source.discountLabelStyle,
    },
  });
}
