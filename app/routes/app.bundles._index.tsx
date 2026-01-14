import { useEffect, useState } from "react";
import { useLoaderData, useFetcher, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getBundles, getBundleStats, deleteBundle, duplicateBundle } from "../models/bundle.server";
import type { BundleWithRelations } from "../models/bundle.server";
import type { BundleStatus } from "@prisma/client";

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
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const bundleId = formData.get("bundleId") as string;

  if (intent === "delete") {
    await deleteBundle(bundleId, shop);
    return { success: true, action: "deleted" };
  }

  if (intent === "duplicate") {
    const newBundle = await duplicateBundle(bundleId, shop);
    return { success: true, action: "duplicated", bundleId: newBundle.id };
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

function getStatusBadgeVariant(status: BundleStatus): string {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "DRAFT":
      return "info";
    case "ARCHIVED":
      return "subdued";
    default:
      return "default";
  }
}

export default function BundleList() {
  const { bundles, stats, statusFilter, searchQuery } = useLoaderData<LoaderData>();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const shopify = useAppBridge();

  const [search, setSearch] = useState(searchQuery || "");
  const [selectedStatus, setSelectedStatus] = useState<BundleStatus | "">(statusFilter || "");

  useEffect(() => {
    if (fetcher.data?.action === "deleted") {
      shopify.toast.show("Bundle deleted");
    } else if (fetcher.data?.action === "duplicated") {
      shopify.toast.show("Bundle duplicated");
    }
  }, [fetcher.data, shopify]);

  const handleSearch = () => {
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    if (selectedStatus) params.set("status", selectedStatus);
    navigate(`/app/bundles?${params.toString()}`);
  };

  const handleStatusFilter = (status: BundleStatus | "") => {
    setSelectedStatus(status);
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    if (status) params.set("status", status);
    navigate(`/app/bundles?${params.toString()}`);
  };

  const handleDelete = (bundleId: string, title: string) => {
    if (confirm(`Are you sure you want to delete "${title}"?`)) {
      fetcher.submit(
        { intent: "delete", bundleId },
        { method: "POST" }
      );
    }
  };

  const handleDuplicate = (bundleId: string) => {
    fetcher.submit(
      { intent: "duplicate", bundleId },
      { method: "POST" }
    );
  };

  return (
    <s-page heading="Add-On Bundles">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => navigate("/app/bundles/new")}
      >
        Create bundle
      </s-button>

      {/* Stats Cards */}
      <s-section>
        <s-stack direction="inline" gap="base" wrap>
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background={selectedStatus === "" ? "emphasis" : "default"}
            onClick={() => handleStatusFilter("")}
            style={{ cursor: "pointer", minWidth: "120px" }}
          >
            <s-stack direction="block" gap="tight">
              <s-text variant="headingLg">{stats.total}</s-text>
              <s-text variant="bodySm" color="subdued">All Bundles</s-text>
            </s-stack>
          </s-box>
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background={selectedStatus === "ACTIVE" ? "emphasis" : "default"}
            onClick={() => handleStatusFilter("ACTIVE")}
            style={{ cursor: "pointer", minWidth: "120px" }}
          >
            <s-stack direction="block" gap="tight">
              <s-text variant="headingLg" color="success">{stats.active}</s-text>
              <s-text variant="bodySm" color="subdued">Active</s-text>
            </s-stack>
          </s-box>
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background={selectedStatus === "DRAFT" ? "emphasis" : "default"}
            onClick={() => handleStatusFilter("DRAFT")}
            style={{ cursor: "pointer", minWidth: "120px" }}
          >
            <s-stack direction="block" gap="tight">
              <s-text variant="headingLg" color="info">{stats.draft}</s-text>
              <s-text variant="bodySm" color="subdued">Draft</s-text>
            </s-stack>
          </s-box>
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background={selectedStatus === "ARCHIVED" ? "emphasis" : "default"}
            onClick={() => handleStatusFilter("ARCHIVED")}
            style={{ cursor: "pointer", minWidth: "120px" }}
          >
            <s-stack direction="block" gap="tight">
              <s-text variant="headingLg" color="subdued">{stats.archived}</s-text>
              <s-text variant="bodySm" color="subdued">Archived</s-text>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      {/* Search */}
      <s-section>
        <s-stack direction="inline" gap="base" align="end">
          <s-text-field
            label="Search bundles"
            value={search}
            onInput={(e: CustomEvent) => setSearch((e.target as HTMLInputElement).value)}
            placeholder="Search by title..."
            style={{ flex: 1 }}
          />
          <s-button onClick={handleSearch}>Search</s-button>
        </s-stack>
      </s-section>

      {/* Bundle List */}
      <s-section>
        {bundles.length === 0 ? (
          <s-box padding="extraLarge" textAlign="center">
            <s-stack direction="block" gap="base" align="center">
              <s-text variant="headingMd">No bundles found</s-text>
              <s-text color="subdued">
                {searchQuery || statusFilter
                  ? "Try adjusting your search or filter"
                  : "Create your first add-on bundle to get started"}
              </s-text>
              {!searchQuery && !statusFilter && (
                <s-button variant="primary" onClick={() => navigate("/app/bundles/new")}>
                  Create bundle
                </s-button>
              )}
            </s-stack>
          </s-box>
        ) : (
          <s-stack direction="block" gap="base">
            {bundles.map((bundle) => (
              <s-box
                key={bundle.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="inline" gap="base" align="center" wrap>
                  <s-stack direction="block" gap="tight" style={{ flex: 1 }}>
                    <s-stack direction="inline" gap="tight" align="center">
                      <s-text variant="headingMd">{bundle.title}</s-text>
                      <s-badge variant={getStatusBadgeVariant(bundle.status)}>
                        {bundle.status}
                      </s-badge>
                    </s-stack>
                    {bundle.subtitle && (
                      <s-text color="subdued">{bundle.subtitle}</s-text>
                    )}
                    <s-stack direction="inline" gap="loose">
                      <s-text variant="bodySm" color="subdued">
                        {bundle._count?.addOnSets || bundle.addOnSets.length} add-on{(bundle._count?.addOnSets || bundle.addOnSets.length) !== 1 ? "s" : ""}
                      </s-text>
                      <s-text variant="bodySm" color="subdued">
                        Targeting: {bundle.targetingType.replace(/_/g, " ").toLowerCase()}
                      </s-text>
                      {bundle.startDate && (
                        <s-text variant="bodySm" color="subdued">
                          Starts: {formatDate(bundle.startDate)}
                        </s-text>
                      )}
                      {bundle.endDate && (
                        <s-text variant="bodySm" color="subdued">
                          Ends: {formatDate(bundle.endDate)}
                        </s-text>
                      )}
                    </s-stack>
                  </s-stack>
                  <s-stack direction="inline" gap="tight">
                    <s-button
                      variant="secondary"
                      onClick={() => navigate(`/app/bundles/${bundle.id}`)}
                    >
                      Edit
                    </s-button>
                    <s-button
                      variant="tertiary"
                      onClick={() => handleDuplicate(bundle.id)}
                    >
                      Duplicate
                    </s-button>
                    <s-button
                      variant="tertiary"
                      tone="critical"
                      onClick={() => handleDelete(bundle.id, bundle.title)}
                    >
                      Delete
                    </s-button>
                  </s-stack>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs: Parameters<typeof boundary.headers>[0]) => {
  return boundary.headers(headersArgs);
};
