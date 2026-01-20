import { useEffect, useState, useRef, useCallback } from "react";
import { useLoaderData, useFetcher, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getBundles, getBundleStats, deleteBundle, duplicateBundle, getBundle, updateBundle } from "../models/bundle.server";
import type { BundleWithRelations } from "../models/bundle.server";
import type { BundleStatus } from "@prisma/client";
import { clearShopMetafield, clearProductMetafields } from "../services/metafield.sync";
import { getTargetedItems } from "../models/targeting.server";
import { deactivateBundleDiscount } from "../services/discount.sync";

interface LoaderData {
  bundles: BundleWithRelations[];
  stats: {
    total: number;
    active: number;
    draft: number;
    archived: number;
  };
  statusFilter: BundleStatus | null;
  searchQuery: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status") as BundleStatus | null;
  const searchQuery = url.searchParams.get("q") || "";

  const [bundles, stats] = await Promise.all([
    getBundles(shop, {
      status: statusFilter || undefined,
      search: searchQuery || undefined,
    }),
    getBundleStats(shop),
  ]);

  return { bundles, stats, statusFilter, searchQuery };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const bundleId = formData.get("bundleId") as string;

  if (intent === "delete") {
    console.log("[deleteBundle] Starting delete for bundle:", bundleId);

    // Get the bundle first to check for discount
    const bundleToDelete = await getBundle(bundleId, shop);
    console.log("[deleteBundle] Bundle to delete:", bundleToDelete?.id, "targetingType:", bundleToDelete?.targetingType);

    if (bundleToDelete) {
      // Delete the Shopify discount if it exists
      if (bundleToDelete.shopifyDiscountId) {
        try {
          console.log("[deleteBundle] Deactivating discount:", bundleToDelete.shopifyDiscountId);
          const discountResult = await deactivateBundleDiscount(admin, shop, bundleToDelete);
          console.log("[deleteBundle] Discount deactivation result:", discountResult);
        } catch (error) {
          console.error("[deleteBundle] Error deleting discount:", error);
        }
      }

      // Clear the shop metafield if this was an ALL_PRODUCTS bundle
      if (bundleToDelete.targetingType === "ALL_PRODUCTS") {
        console.log("[deleteBundle] Clearing shop metafield for ALL_PRODUCTS bundle");
        try {
          const shopResponse = await admin.graphql(`query { shop { id } }`);
          const shopResult = await shopResponse.json();
          const shopGid = (shopResult.data?.shop as { id?: string })?.id;
          console.log("[deleteBundle] Shop GID:", shopGid);

          if (shopGid) {
            const metafieldResult = await clearShopMetafield(admin, shopGid);
            console.log("[deleteBundle] Metafield clear result:", metafieldResult);

            if (!metafieldResult.success) {
              console.error("[deleteBundle] Failed to clear metafield:", metafieldResult.error);
            }
          } else {
            console.error("[deleteBundle] Could not get shop GID");
          }
        } catch (error) {
          console.error("[deleteBundle] Error clearing shop metafield:", error);
        }
      }

      // Clear product metafields if this was a SPECIFIC_PRODUCTS or PRODUCT_GROUPS bundle
      if (bundleToDelete.targetingType === "SPECIFIC_PRODUCTS" || bundleToDelete.targetingType === "PRODUCT_GROUPS") {
        console.log("[deleteBundle] Clearing product metafields for", bundleToDelete.targetingType, "bundle");
        try {
          // Get the targeted product IDs
          const targetedItems = await getTargetedItems(bundleId);
          const productIds = targetedItems
            .filter(item => item.shopifyResourceType === "Product")
            .map(item => item.shopifyResourceId);

          console.log("[deleteBundle] Found", productIds.length, "product metafields to clear");

          if (productIds.length > 0) {
            await clearProductMetafields(admin, productIds);
            console.log("[deleteBundle] Product metafields cleared");
          }
        } catch (error) {
          console.error("[deleteBundle] Error clearing product metafields:", error);
        }
      }
    }

    await deleteBundle(bundleId, shop);
    console.log("[deleteBundle] Bundle deleted from database");
    return { success: true, action: "deleted" };
  }

  if (intent === "duplicate") {
    const newBundle = await duplicateBundle(bundleId, shop);
    return { success: true, action: "duplicated", bundleId: newBundle.id };
  }

  if (intent === "toggleStatus") {
    const newStatus = formData.get("newStatus") as BundleStatus;
    await updateBundle(bundleId, shop, { status: newStatus });
    return { success: true, action: "statusChanged", newStatus };
  }

  return { success: false };
};

function formatDate(date: Date | string | null): string {
  if (!date) return "—";
  const d = new Date(date);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getStatusBadgeVariant(status: BundleStatus): 'info' | 'success' | 'warning' | 'critical' {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "DRAFT":
      return "info";
    case "ARCHIVED":
      return "warning";
    default:
      return "info";
  }
}

// Delete Confirmation Modal Component
function DeleteBundleModal({
  isOpen,
  bundleTitle,
  onClose,
  onConfirm,
}: {
  isOpen: boolean;
  bundleTitle: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!isOpen) return null;

  const overlayStyle: React.CSSProperties = {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  };

  const modalContentStyle: React.CSSProperties = {
    backgroundColor: "#fff",
    borderRadius: "16px",
    width: "90%",
    maxWidth: "420px",
    overflow: "hidden",
    boxShadow: "0 20px 60px rgba(0, 0, 0, 0.3)",
  };

  const headerStyle: React.CSSProperties = {
    background: "linear-gradient(135deg, #d72c0d 0%, #b91c1c 100%)",
    padding: "24px",
    textAlign: "center",
  };

  const iconContainerStyle: React.CSSProperties = {
    width: "64px",
    height: "64px",
    borderRadius: "50%",
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: "0 auto 16px",
  };

  const bodyStyle: React.CSSProperties = {
    padding: "24px",
    textAlign: "center",
  };

  const buttonContainerStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    padding: "0 24px 24px",
  };

  const cancelButtonStyle: React.CSSProperties = {
    width: "100%",
    padding: "12px 24px",
    borderRadius: "8px",
    border: "1px solid #e0e0e0",
    backgroundColor: "#fff",
    color: "#202223",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: 600,
  };

  const deleteButtonStyle: React.CSSProperties = {
    width: "100%",
    padding: "12px 24px",
    borderRadius: "8px",
    border: "none",
    backgroundColor: "#d72c0d",
    color: "#fff",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: 600,
  };

  const bundleNameStyle: React.CSSProperties = {
    display: "inline-block",
    backgroundColor: "#f6f6f7",
    padding: "6px 12px",
    borderRadius: "6px",
    color: "#616161",
    fontSize: "13px",
    fontWeight: 500,
    marginTop: "8px",
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalContentStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <div style={iconContainerStyle}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              <line x1="10" y1="11" x2="10" y2="17"></line>
              <line x1="14" y1="11" x2="14" y2="17"></line>
            </svg>
          </div>
          <h2 style={{ color: "#fff", fontSize: "20px", fontWeight: 600, margin: 0 }}>
            Delete Bundle
          </h2>
        </div>
        <div style={bodyStyle}>
          <p style={{ color: "#202223", fontSize: "15px", margin: "0 0 8px", lineHeight: 1.5 }}>
            Are you sure you want to delete this bundle? This action cannot be undone and will remove all associated add-ons and settings.
          </p>
          <span style={bundleNameStyle}>{bundleTitle}</span>
        </div>
        <div style={buttonContainerStyle}>
          <button style={cancelButtonStyle} onClick={onClose}>
            Cancel
          </button>
          <button style={deleteButtonStyle} onClick={onConfirm}>
            Delete Bundle
          </button>
        </div>
      </div>
    </div>
  );
}

// Feature Card Component
function FeatureCard({
  icon,
  title,
  description,
  color,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  color: string;
}) {
  const cardStyle: React.CSSProperties = {
    backgroundColor: "#fff",
    borderRadius: "16px",
    padding: "24px",
    border: "1px solid #e3e3e3",
    flex: "1",
    minWidth: "280px",
    transition: "all 0.2s ease",
  };

  const iconStyle: React.CSSProperties = {
    width: "48px",
    height: "48px",
    borderRadius: "12px",
    backgroundColor: color,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: "16px",
  };

  return (
    <div style={cardStyle}>
      <div style={iconStyle}>{icon}</div>
      <h3 style={{ fontSize: "16px", fontWeight: 600, color: "#202223", margin: "0 0 8px" }}>
        {title}
      </h3>
      <p style={{ fontSize: "14px", color: "#6d7175", margin: 0, lineHeight: 1.5 }}>
        {description}
      </p>
    </div>
  );
}

// Stat Card Component
function StatCard({
  value,
  label,
  color,
  isActive,
  onClick,
}: {
  value: number;
  label: string;
  color: string;
  isActive: boolean;
  onClick: () => void;
}) {
  const cardStyle: React.CSSProperties = {
    backgroundColor: isActive ? "#f4f6f8" : "#fff",
    borderRadius: "12px",
    padding: "20px 24px",
    border: isActive ? "2px solid #008060" : "1px solid #e3e3e3",
    cursor: "pointer",
    transition: "all 0.2s ease",
    minWidth: "140px",
    textAlign: "center",
  };

  return (
    <div style={cardStyle} onClick={onClick}>
      <div style={{ fontSize: "32px", fontWeight: 700, color, marginBottom: "4px" }}>
        {value}
      </div>
      <div style={{ fontSize: "13px", color: "#6d7175", fontWeight: 500 }}>
        {label}
      </div>
    </div>
  );
}

// Toggle Switch Component
function StatusToggle({
  bundleId,
  currentStatus,
  onToggle,
  isLoading,
}: {
  bundleId: string;
  currentStatus: BundleStatus;
  onToggle: (bundleId: string, newStatus: BundleStatus) => void;
  isLoading: boolean;
}) {
  const isActive = currentStatus === "ACTIVE";
  const isDraft = currentStatus === "DRAFT";

  // Only show toggle for ACTIVE and ARCHIVED statuses
  if (isDraft) {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "6px 12px",
          backgroundColor: "#e4f5ff",
          borderRadius: "20px",
          fontSize: "12px",
          fontWeight: 500,
          color: "#006fbb",
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
        Draft
      </span>
    );
  }

  const containerStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  };

  const toggleContainerStyle: React.CSSProperties = {
    position: "relative",
    width: "44px",
    height: "24px",
    cursor: isLoading ? "wait" : "pointer",
    opacity: isLoading ? 0.6 : 1,
  };

  const toggleTrackStyle: React.CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: isActive ? "#008060" : "#8c9196",
    borderRadius: "12px",
    transition: "background-color 0.2s ease",
  };

  const toggleThumbStyle: React.CSSProperties = {
    position: "absolute",
    top: "2px",
    left: isActive ? "22px" : "2px",
    width: "20px",
    height: "20px",
    backgroundColor: "#fff",
    borderRadius: "50%",
    transition: "left 0.2s ease",
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.2)",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: "12px",
    fontWeight: 500,
    color: isActive ? "#008060" : "#6d7175",
  };

  const handleClick = () => {
    if (!isLoading) {
      const newStatus = isActive ? "ARCHIVED" : "ACTIVE";
      onToggle(bundleId, newStatus);
    }
  };

  return (
    <div style={containerStyle}>
      <span style={labelStyle}>{isActive ? "Active" : "Archived"}</span>
      <div style={toggleContainerStyle} onClick={handleClick}>
        <div style={toggleTrackStyle}></div>
        <div style={toggleThumbStyle}></div>
      </div>
    </div>
  );
}

// Bundle List Item Component
function BundleListItem({
  bundle,
  onEdit,
  onDuplicate,
  onDelete,
  onToggleStatus,
  isLoading,
}: {
  bundle: BundleWithRelations;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onToggleStatus: (bundleId: string, newStatus: BundleStatus) => void;
  isLoading: boolean;
}) {
  const cardStyle: React.CSSProperties = {
    backgroundColor: "#fff",
    borderRadius: "12px",
    padding: "20px 24px",
    border: "1px solid #e3e3e3",
    marginBottom: "12px",
    transition: "all 0.2s ease",
  };

  const headerStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "16px",
    flexWrap: "wrap",
  };

  const titleSectionStyle: React.CSSProperties = {
    flex: 1,
    minWidth: "200px",
  };

  const actionSectionStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    flexWrap: "wrap",
  };

  const buttonStyle: React.CSSProperties = {
    padding: "8px 16px",
    borderRadius: "8px",
    border: "1px solid #c9cccf",
    backgroundColor: "#fff",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: 500,
    color: "#202223",
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    transition: "all 0.15s ease",
  };

  const primaryButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    backgroundColor: "#008060",
    borderColor: "#008060",
    color: "#fff",
  };

  const dangerButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    color: "#d72c0d",
    borderColor: "#ffd8d8",
    backgroundColor: "#fff5f5",
  };

  const metaStyle: React.CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    gap: "16px",
    marginTop: "12px",
    paddingTop: "12px",
    borderTop: "1px solid #f1f1f1",
  };

  const metaItemStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "13px",
    color: "#6d7175",
  };

  const addOnCount = bundle._count?.addOnSets || bundle.addOnSets.length;

  return (
    <div style={cardStyle}>
      <div style={headerStyle}>
        <div style={titleSectionStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
            <h3 style={{ fontSize: "16px", fontWeight: 600, color: "#202223", margin: 0 }}>
              {bundle.title}
            </h3>
            <StatusToggle
              bundleId={bundle.id}
              currentStatus={bundle.status}
              onToggle={onToggleStatus}
              isLoading={isLoading}
            />
          </div>
          {bundle.subtitle && (
            <p style={{ fontSize: "14px", color: "#6d7175", margin: 0 }}>
              {bundle.subtitle}
            </p>
          )}
        </div>
        <div style={actionSectionStyle}>
          <button style={primaryButtonStyle} onClick={onEdit}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            Edit
          </button>
          <button style={buttonStyle} onClick={onDuplicate}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            Duplicate
          </button>
          <button style={dangerButtonStyle} onClick={onDelete}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            Delete
          </button>
        </div>
      </div>
      <div style={metaStyle}>
        <div style={metaItemStyle}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8c9196" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="9" y1="21" x2="9" y2="9" />
          </svg>
          {addOnCount} add-on{addOnCount !== 1 ? "s" : ""}
        </div>
        <div style={metaItemStyle}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8c9196" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          {bundle.targetingType.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (l) => l.toUpperCase())}
        </div>
        {bundle.startDate && (
          <div style={metaItemStyle}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8c9196" strokeWidth="2">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            Starts: {formatDate(bundle.startDate)}
          </div>
        )}
        {bundle.endDate && (
          <div style={metaItemStyle}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8c9196" strokeWidth="2">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            Ends: {formatDate(bundle.endDate)}
          </div>
        )}
      </div>
    </div>
  );
}

export default function BundleList() {
  const { bundles, stats, statusFilter, searchQuery } = useLoaderData<LoaderData>();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const shopify = useAppBridge();

  const [search, setSearch] = useState(searchQuery || "");
  const [selectedStatus, setSelectedStatus] = useState<BundleStatus | "">(statusFilter || "");
  const [deleteModal, setDeleteModal] = useState<{ isOpen: boolean; bundleId: string; title: string }>({
    isOpen: false,
    bundleId: "",
    title: "",
  });

  // Ref for create bundle button
  const createBundleButtonRef = useRef<HTMLElement>(null);

  const handleCreateBundle = useCallback(() => {
    navigate("/app/bundles/new");
  }, [navigate]);

  // Attach event listener for create bundle button
  useEffect(() => {
    const btn = createBundleButtonRef.current;
    if (btn) {
      btn.addEventListener("click", handleCreateBundle);
      return () => btn.removeEventListener("click", handleCreateBundle);
    }
  }, [handleCreateBundle]);

  useEffect(() => {
    if (fetcher.data?.action === "deleted") {
      shopify.toast.show("Bundle deleted successfully");
    } else if (fetcher.data?.action === "duplicated") {
      shopify.toast.show("Bundle duplicated successfully");
    } else if (fetcher.data?.action === "statusChanged") {
      const status = fetcher.data.newStatus === "ACTIVE" ? "activated" : "archived";
      shopify.toast.show(`Bundle ${status} successfully`);
    }
  }, [fetcher.data, shopify]);

  const handleSearch = () => {
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    if (selectedStatus) params.set("status", selectedStatus);
    navigate(`/app/bundles?${params.toString()}`);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSearch();
    }
  };

  const handleStatusFilter = (status: BundleStatus | "") => {
    setSelectedStatus(status);
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    if (status) params.set("status", status);
    navigate(`/app/bundles?${params.toString()}`);
  };

  const openDeleteModal = (bundleId: string, title: string) => {
    setDeleteModal({ isOpen: true, bundleId, title });
  };

  const closeDeleteModal = () => {
    setDeleteModal({ isOpen: false, bundleId: "", title: "" });
  };

  const handleDelete = () => {
    fetcher.submit(
      { intent: "delete", bundleId: deleteModal.bundleId },
      { method: "POST" }
    );
    closeDeleteModal();
  };

  const handleDuplicate = (bundleId: string) => {
    fetcher.submit(
      { intent: "duplicate", bundleId },
      { method: "POST" }
    );
  };

  const handleToggleStatus = (bundleId: string, newStatus: BundleStatus) => {
    fetcher.submit(
      { intent: "toggleStatus", bundleId, newStatus },
      { method: "POST" }
    );
  };

  // Page styles
  const pageContainerStyle: React.CSSProperties = {
    maxWidth: "1200px",
    margin: "0 auto",
    padding: "0 20px",
  };

  const heroSectionStyle: React.CSSProperties = {
    background: "linear-gradient(135deg, #008060 0%, #004c3f 100%)",
    borderRadius: "20px",
    padding: "40px",
    marginBottom: "32px",
    color: "#fff",
    position: "relative",
    overflow: "hidden",
  };

  const heroPatternStyle: React.CSSProperties = {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: "50%",
    opacity: 0.1,
    background: "url(\"data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E\")",
  };

  const searchContainerStyle: React.CSSProperties = {
    display: "flex",
    gap: "12px",
    marginBottom: "24px",
    flexWrap: "wrap",
  };

  const searchInputStyle: React.CSSProperties = {
    flex: 1,
    minWidth: "250px",
    padding: "12px 16px",
    borderRadius: "10px",
    border: "1px solid #c9cccf",
    fontSize: "14px",
    outline: "none",
  };

  const searchButtonStyle: React.CSSProperties = {
    padding: "12px 24px",
    borderRadius: "10px",
    border: "none",
    backgroundColor: "#008060",
    color: "#fff",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: 600,
    display: "flex",
    alignItems: "center",
    gap: "8px",
  };

  const featuresSectionStyle: React.CSSProperties = {
    display: "flex",
    gap: "20px",
    marginBottom: "32px",
    flexWrap: "wrap",
  };

  const statsSectionStyle: React.CSSProperties = {
    display: "flex",
    gap: "16px",
    marginBottom: "32px",
    flexWrap: "wrap",
  };

  const sectionTitleStyle: React.CSSProperties = {
    fontSize: "18px",
    fontWeight: 600,
    color: "#202223",
    marginBottom: "16px",
  };

  const emptyStateStyle: React.CSSProperties = {
    backgroundColor: "#f9fafb",
    borderRadius: "16px",
    padding: "60px 40px",
    textAlign: "center",
    border: "2px dashed #c9cccf",
  };

  const createButtonStyle: React.CSSProperties = {
    padding: "14px 28px",
    borderRadius: "10px",
    border: "none",
    backgroundColor: "#008060",
    color: "#fff",
    cursor: "pointer",
    fontSize: "15px",
    fontWeight: 600,
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    marginTop: "20px",
  };

  return (
    <s-page heading="Add-On Bundles">
      <s-button
        ref={createBundleButtonRef}
        slot="primary-action"
        variant="primary"
      >
        Create Bundle
      </s-button>

      <div style={pageContainerStyle}>
        {/* Hero Section */}
        <div style={heroSectionStyle}>
          <div style={heroPatternStyle}></div>
          <div style={{ position: "relative", zIndex: 1 }}>
            <h1 style={{ fontSize: "28px", fontWeight: 700, marginBottom: "12px", margin: 0 }}>
              Boost Your Sales with Add-On Bundles
            </h1>
            <p style={{ fontSize: "16px", opacity: 0.9, marginBottom: "24px", maxWidth: "600px", lineHeight: 1.6 }}>
              Create irresistible product bundles that increase average order value.
              Offer complementary products, gift options, and special deals that customers love.
            </p>
            <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>Increase AOV by 25%+</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>Easy Setup</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>Customizable Widgets</span>
              </div>
            </div>
          </div>
        </div>

        {/* Features Section */}
        <div style={featuresSectionStyle}>
          <FeatureCard
            icon={
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
                <circle cx="9" cy="21" r="1" />
                <circle cx="20" cy="21" r="1" />
                <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
              </svg>
            }
            title="Upsell & Cross-sell"
            description="Offer complementary products at checkout to maximize every order's potential."
            color="#008060"
          />
          <FeatureCard
            icon={
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
                <line x1="12" y1="1" x2="12" y2="23" />
                <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
            }
            title="Flexible Discounts"
            description="Create percentage off, fixed amount, or free gift offers to drive conversions."
            color="#5c6ac4"
          />
          <FeatureCard
            icon={
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="3" y1="9" x2="21" y2="9" />
                <line x1="9" y1="21" x2="9" y2="9" />
              </svg>
            }
            title="Smart Targeting"
            description="Show bundles on all products, specific items, or organized product groups."
            color="#bf0711"
          />
        </div>

        {/* Stats Section */}
        <h2 style={sectionTitleStyle}>Bundle Overview</h2>
        <div style={statsSectionStyle}>
          <StatCard
            value={stats.total}
            label="Total Bundles"
            color="#202223"
            isActive={selectedStatus === ""}
            onClick={() => handleStatusFilter("")}
          />
          <StatCard
            value={stats.active}
            label="Active"
            color="#008060"
            isActive={selectedStatus === "ACTIVE"}
            onClick={() => handleStatusFilter("ACTIVE")}
          />
          <StatCard
            value={stats.draft}
            label="Draft"
            color="#006fbb"
            isActive={selectedStatus === "DRAFT"}
            onClick={() => handleStatusFilter("DRAFT")}
          />
          <StatCard
            value={stats.archived}
            label="Archived"
            color="#8c9196"
            isActive={selectedStatus === "ARCHIVED"}
            onClick={() => handleStatusFilter("ARCHIVED")}
          />
        </div>

        {/* Search Section */}
        <div style={searchContainerStyle}>
          <input
            type="text"
            placeholder="Search bundles by title..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            style={searchInputStyle}
          />
          <button style={searchButtonStyle} onClick={handleSearch}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            Search
          </button>
        </div>

        {/* Bundle List */}
        <h2 style={sectionTitleStyle}>
          {selectedStatus ? `${selectedStatus.charAt(0) + selectedStatus.slice(1).toLowerCase()} Bundles` : "All Bundles"}
          {bundles.length > 0 && <span style={{ fontWeight: 400, color: "#6d7175" }}> ({bundles.length})</span>}
        </h2>

        {bundles.length === 0 ? (
          <div style={emptyStateStyle}>
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#c9cccf" strokeWidth="1.5" style={{ marginBottom: "20px" }}>
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="3" y1="9" x2="21" y2="9" />
              <line x1="9" y1="21" x2="9" y2="9" />
            </svg>
            <h3 style={{ fontSize: "18px", fontWeight: 600, color: "#202223", margin: "0 0 8px" }}>
              {searchQuery || statusFilter
                ? "No bundles found"
                : "Create your first bundle"}
            </h3>
            <p style={{ fontSize: "14px", color: "#6d7175", margin: 0, maxWidth: "400px", marginLeft: "auto", marginRight: "auto" }}>
              {searchQuery || statusFilter
                ? "Try adjusting your search or filter to find what you're looking for."
                : "Start increasing your average order value by creating add-on bundles that customers can't resist."}
            </p>
            {!searchQuery && !statusFilter && (
              <button style={createButtonStyle} onClick={() => navigate("/app/bundles/new")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Create Your First Bundle
              </button>
            )}
          </div>
        ) : (
          <div>
            {bundles.map((bundle) => (
              <BundleListItem
                key={bundle.id}
                bundle={bundle}
                onEdit={() => navigate(`/app/bundles/${bundle.id}`)}
                onDuplicate={() => handleDuplicate(bundle.id)}
                onDelete={() => openDeleteModal(bundle.id, bundle.title)}
                onToggleStatus={handleToggleStatus}
                isLoading={fetcher.state !== "idle"}
              />
            ))}
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      <DeleteBundleModal
        isOpen={deleteModal.isOpen}
        bundleTitle={deleteModal.title}
        onClose={closeDeleteModal}
        onConfirm={handleDelete}
      />
    </s-page>
  );
}

export const headers = (headersArgs: Parameters<typeof boundary.headers>[0]) => {
  return boundary.headers(headersArgs);
};
