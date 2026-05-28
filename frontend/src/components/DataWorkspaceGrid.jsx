import React, { useState } from "react";
import * as XLSX from "xlsx";

/**
 * DataWorkspaceGrid
 *
 * Displays normalized emissions rows with status-aware visual badges.
 * This table is designed for high audit scannability and side-by-side
 * visibility into transformed values and validation context.
 */
function getStatusConfig(record) {
  const status = record.verification_status;
  const errors = record.raw_record?.validation_errors || [];
  if (status === "APPROVED_LOCKED") {
    return {
      label: "Approved Locked",
      badgeClass: "bg-emerald-600/20 text-emerald-200 border-emerald-500/40",
      warning: "Record is approved and immutable.",
    };
  }
  if (status === "SUSPICIOUS") {
    return {
      label: "Suspicious",
      badgeClass: "bg-amber-500/20 text-amber-200 border-amber-500/40",
      warning: errors.join(" | ") || "Potential anomaly detected.",
    };
  }
  if (status === "VALIDATION_FAILED") {
    return {
      label: "Validation Failed",
      badgeClass: "bg-rose-500/20 text-rose-200 border-rose-500/40",
      warning: errors.join(" | ") || "Fatal parsing or validation error.",
    };
  }
  return {
    label: "Pending Review",
    badgeClass: "bg-emerald-500/20 text-emerald-200 border-emerald-500/40",
    warning: "",
  };
}

function renderScope(scopeCategory) {
  if (scopeCategory === "SCOPE_1") return "Scope 1";
  if (scopeCategory === "SCOPE_2") return "Scope 2";
  if (scopeCategory === "SCOPE_3") return "Scope 3";
  return scopeCategory;
}

/**
 * exportWorkspaceExcel
 * Maps the active batch records array into a structured SheetJS workbook
 * and triggers a native .xlsx binary download — zero CSV intermediates.
 *
 * Sheet columns:
 *   Record ID | Validation Status | Activity Type | Scope Category |
 *   Raw Quantity & Unit | Standardized Quantity | Calculated CO2e (kg) | Billing Range
 */
function exportWorkspaceExcel(records) {
  const sheetData = records.map((r) => ({
    "Record ID": r.id,
    "Validation Status": r.verification_status,
    "Activity Type": r.activity_type,
    "Scope Category": renderScope(r.scope_category),
    "Raw Quantity & Unit": `${r.raw_quantity ?? ""} ${r.raw_unit ?? ""}`.trim(),
    "Standardized Quantity": `${r.normalized_quantity ?? ""} ${r.normalized_unit ?? ""}`.trim(),
    "Calculated CO2e (kg)": r.calculated_co2e_kg,
    "Billing Range": `${r.billing_start_date ?? ""} to ${r.billing_end_date ?? ""}`,
  }));

  const worksheet = XLSX.utils.json_to_sheet(sheetData);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Normalized Ingestion Data");
  XLSX.writeFile(workbook, "breathe_esg_workspace_records.xlsx");
}

export default function DataWorkspaceGrid({
  records,
  isLoading,
  selectedBatchId,
  sectionTitle = "Analyst Data Workspace",
  currentView = "workspace",
  onApproveAndLock,
  onFlagForReview,
  actionLoadingRecordIds = {},
}) {
  const [flagInputByRecord, setFlagInputByRecord] = useState({});
  const [activeFlagPopoverRecordId, setActiveFlagPopoverRecordId] = useState(null);

  function handleFlagInputChange(recordId, value) {
    setFlagInputByRecord((previous) => ({
      ...previous,
      [recordId]: value,
    }));
  }

  async function handleFlagSubmit(record) {
    const comment = (flagInputByRecord[record.id] || "").trim();
    if (!comment) {
      return;
    }
    await onFlagForReview(record, comment);
    setFlagInputByRecord((previous) => ({
      ...previous,
      [record.id]: "",
    }));
    setActiveFlagPopoverRecordId(null);
  }

  if (isLoading) {
    return (
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/90 p-4 shadow-2xl shadow-black/30">
        <h2 className="mb-3 text-lg font-semibold text-zinc-100">{sectionTitle}</h2>
        <p className="text-sm text-zinc-400">Loading normalized emissions records...</p>
      </section>
    );
  }

  if (!selectedBatchId && currentView !== "anomaly" && currentView !== "ledger") {
    return (
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/90 p-4 shadow-2xl shadow-black/30">
        <h2 className="mb-3 text-lg font-semibold text-zinc-100">{sectionTitle}</h2>
        <p className="text-sm text-zinc-400">Select a batch to view normalized records.</p>
      </section>
    );
  }

  if (!records || records.length === 0) {
    const emptyMessage =
      currentView === "anomaly"
        ? "No suspicious or failed records were found for the selected context."
        : currentView === "ledger"
          ? "No approved locked records are available in this ledger view."
          : "No records were found for this batch.";
    return (
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/90 p-4 shadow-2xl shadow-black/30">
        <h2 className="mb-3 text-lg font-semibold text-zinc-100">{sectionTitle}</h2>
        <p className="text-sm text-zinc-400">{emptyMessage}</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/90 p-4 shadow-2xl shadow-black/30 backdrop-blur">
      {/* ── Panel Header ── */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold tracking-wide text-zinc-100">{sectionTitle}</h2>
          <span className="text-xs text-zinc-400">
            Active Batch: #{selectedBatchId} • Rows: {records.length}
          </span>
        </div>

        {/* ── Export Excel Button ── */}
        <button
          type="button"
          onClick={() => exportWorkspaceExcel(records)}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-zinc-200 shadow-sm transition hover:border-emerald-500/60 hover:bg-zinc-700 hover:text-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
          title="Download the current workspace records as a native Excel .xlsx file"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            fill="currentColor"
            className="h-3.5 w-3.5"
            aria-hidden="true"
          >
            <path d="M8 1a.75.75 0 0 1 .75.75v6.19l1.97-1.97a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.03a.75.75 0 0 1 1.06-1.06L7.25 7.94V1.75A.75.75 0 0 1 8 1ZM2.5 13.25a.75.75 0 0 1 .75-.75h9.5a.75.75 0 0 1 0 1.5h-9.5a.75.75 0 0 1-.75-.75Z" />
          </svg>
          Export Table (Excel)
        </button>
      </div>

      {/* w-full keeps the scroll container flush with the section;
          overflow-x-auto lets wide column sets scroll as one solid unit. */}
      <div className="w-full overflow-x-auto overflow-y-visible">
        <table className="w-full table-auto divide-y divide-zinc-800 text-sm">
          {/* ── Table Header ──
              Every <th> carries text-left + px-4 py-3 to perfectly
              mirror the matching <td> below it.
              Wide descriptive columns also get whitespace-nowrap + min-w-[...]
              so labels never compress or clip. */}
          <thead className="bg-zinc-900/80">
            <tr className="border-l-4 border-transparent">
              <th className="whitespace-nowrap min-w-[96px]  px-4 py-3 text-left font-semibold text-zinc-300">Record ID</th>
              <th className="whitespace-nowrap min-w-[130px] px-4 py-3 text-left font-semibold text-zinc-300">Status</th>
              <th className="whitespace-nowrap min-w-[160px] px-4 py-3 text-left font-semibold text-zinc-300">Activity Type</th>
              <th className="whitespace-nowrap min-w-[100px] px-4 py-3 text-left font-semibold text-zinc-300">Scope</th>
              <th className="whitespace-nowrap min-w-[160px] px-4 py-3 text-left font-semibold text-zinc-300">Raw Quantity &amp; Unit</th>
              <th className="whitespace-nowrap min-w-[180px] px-4 py-3 text-left font-semibold text-zinc-300">Standardized Quantity</th>
              <th className="whitespace-nowrap min-w-[200px] px-4 py-3 text-left font-semibold text-zinc-300">Carbon Footprint (kg CO2e)</th>
              <th className="whitespace-nowrap min-w-[200px] px-4 py-3 text-left font-semibold text-zinc-300">Date Range</th>
              <th className="whitespace-nowrap min-w-[140px] px-4 py-3 text-left font-semibold text-zinc-300">Actions</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-zinc-800">
            {records.map((record) => {
              const statusConfig = getStatusConfig(record);
              const isLocked = record.verification_status === "APPROVED_LOCKED";
              const isActionable =
                record.verification_status === "PENDING_REVIEW" ||
                record.verification_status === "SUSPICIOUS";
              const isActionLoading = Boolean(actionLoadingRecordIds[record.id]);
              const rowFlagComment = flagInputByRecord[record.id] || "";
              const isFlagPopoverOpen = activeFlagPopoverRecordId === record.id;
              const borderClass =
                record.verification_status === "APPROVED_LOCKED"
                  ? "border-l-4 border-emerald-500"
                  : record.verification_status === "SUSPICIOUS"
                    ? "border-l-4 border-amber-500"
                    : record.verification_status === "VALIDATION_FAILED"
                      ? "border-l-4 border-rose-500"
                      : "border-l-4 border-transparent";

              return (
                <tr
                  key={`${record.id}-${record.verification_status}`}
                  className={`transition-all duration-300 ease-out animate-row-state ${borderClass} ${
                    isLocked
                      ? "cursor-not-allowed bg-emerald-900/20 ring-1 ring-inset ring-emerald-500/40"
                      : "bg-zinc-950/20 hover:bg-zinc-900/60"
                  }`}
                  onClick={(event) => {
                    if (isLocked) {
                      event.preventDefault();
                      event.stopPropagation();
                    }
                  }}
                  onDoubleClick={(event) => {
                    if (isLocked) {
                      event.preventDefault();
                      event.stopPropagation();
                    }
                  }}
                >
                  {/* Record ID — text-left matches <th> */}
                  <td
                    className={`whitespace-nowrap px-4 py-3 text-left font-medium text-zinc-100 ${
                      isLocked ? "select-none" : ""
                    }`}
                  >
                    {record.id}
                  </td>

                  {/* Status badge — text-left matches <th> */}
                  <td className="px-4 py-3 text-left">
                    <span
                      className={`inline-flex cursor-help rounded-full border px-2.5 py-1 text-xs font-semibold ${statusConfig.badgeClass}`}
                      title={statusConfig.warning}
                    >
                      {statusConfig.label}
                    </span>
                  </td>

                  {/* Activity Type with optional error badges — text-left matches <th> */}
                  <td className="px-4 py-3 text-left text-zinc-300">
                    <span className="block font-medium">{record.activity_type}</span>
                    {(() => {
                      const validationErrors = [
                        ...(Array.isArray(record.validation_errors) ? record.validation_errors : []),
                        ...(Array.isArray(record.raw_record?.validation_errors)
                          ? record.raw_record.validation_errors
                          : []),
                      ].filter(
                        (value, index, self) =>
                          self.indexOf(value) === index &&
                          typeof value === "string" &&
                          value.trim() !== ""
                      );

                      if (validationErrors.length === 0) return null;

                      return (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {validationErrors.map((error, idx) => (
                            <span
                              key={idx}
                              className="inline-flex items-center rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300 shadow-sm"
                            >
                              {error}
                            </span>
                          ))}
                        </div>
                      );
                    })()}
                  </td>

                  {/* Scope — text-left matches <th> */}
                  <td className="whitespace-nowrap px-4 py-3 text-left text-zinc-300">
                    {renderScope(record.scope_category)}
                  </td>

                  {/* Raw Quantity & Unit — text-left matches <th> */}
                  <td className="whitespace-nowrap px-4 py-3 text-left text-zinc-300">
                    {record.raw_quantity} {record.raw_unit}
                  </td>

                  {/* Standardized Quantity — text-left matches <th> */}
                  <td className="whitespace-nowrap px-4 py-3 text-left text-zinc-300">
                    {record.normalized_quantity} {record.normalized_unit}
                  </td>

                  {/* Carbon Footprint — text-left matches <th> */}
                  <td className="whitespace-nowrap px-4 py-3 text-left font-medium text-zinc-100">
                    {record.calculated_co2e_kg}
                  </td>

                  {/* Date Range — text-left matches <th> */}
                  <td className="whitespace-nowrap px-4 py-3 text-left text-zinc-300">
                    {record.billing_start_date} to {record.billing_end_date}
                  </td>

                  {/* Actions — relative for popover anchor, text-left matches <th> */}
                  <td className="relative px-4 py-3 text-left">
                    {isLocked ? (
                      <div className="rounded-md border border-emerald-500/40 bg-emerald-600/20 px-2 py-1 text-xs font-semibold text-emerald-200">
                        Locked - Immutable
                      </div>
                    ) : isActionable ? (
                      <div className="relative flex min-w-[260px] flex-col gap-2">
                        <button
                          type="button"
                          disabled={isActionLoading}
                          onClick={() => onApproveAndLock(record)}
                          className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm shadow-emerald-900/40 transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-emerald-900 disabled:text-emerald-300"
                        >
                          {isActionLoading ? "Processing..." : "Approve & Lock"}
                        </button>
                        <button
                          type="button"
                          disabled={isActionLoading}
                          onClick={() =>
                            setActiveFlagPopoverRecordId((previous) =>
                              previous === record.id ? null : record.id
                            )
                          }
                          className="whitespace-nowrap rounded-md bg-amber-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 shadow-sm shadow-amber-900/30 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:bg-amber-900 disabled:text-amber-200"
                        >
                          Flag for Review
                        </button>
                        {isFlagPopoverOpen ? (
                          <div className="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border border-zinc-800 bg-zinc-900 p-4 shadow-2xl">
                            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-300">
                              Append Audit Override Context
                            </p>
                            <textarea
                              rows={3}
                              value={rowFlagComment}
                              disabled={isActionLoading}
                              onChange={(event) =>
                                handleFlagInputChange(record.id, event.target.value)
                              }
                              placeholder="Verified meter reading anomaly with facility lead"
                              className="w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                            />
                            <div className="mt-2 flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => setActiveFlagPopoverRecordId(null)}
                                className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-300 transition hover:bg-zinc-800"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                disabled={isActionLoading || rowFlagComment.trim().length === 0}
                                onClick={() => handleFlagSubmit(record)}
                                className="rounded-md bg-amber-500 px-2.5 py-1 text-xs font-semibold text-zinc-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:bg-amber-900 disabled:text-amber-200"
                              >
                                Confirm Flag
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-xs text-zinc-500">No actions</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
