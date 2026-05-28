import React, { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import BatchSelectionPanel from "./BatchSelectionPanel";
import DataWorkspaceGrid from "./DataWorkspaceGrid";
import { approveRecord, flagRecord, getBatches, getOrganizations, getRecords } from "../services/api";

/**
 * DashboardShell
 *
 * Top-level workspace orchestrator for the Breathe ESG analyst experience.
 * Responsibilities:
 * - Tenant context switching (organization selector).
 * - Global KPI counters for operational scannability.
 * - Routing selected batch context into the data workspace grid.
 */
export default function DashboardShell() {
  const operatorId = "analyst@breatheesg.com";
  const [organizations, setOrganizations] = useState([]);
  const [activeOrgId, setActiveOrgId] = useState("");
  const [currentView, setCurrentView] = useState("workspace");
  const [batches, setBatches] = useState([]);
  const [selectedBatchId, setSelectedBatchId] = useState(null);
  const [records, setRecords] = useState([]);
  const [auditEvents, setAuditEvents] = useState([]);
  const [actionLoadingRecordIds, setActionLoadingRecordIds] = useState({});
  const [loadingBatches, setLoadingBatches] = useState(false);
  const [loadingRecords, setLoadingRecords] = useState(false);

  useEffect(() => {
    async function loadOrganizations() {
      const orgData = await getOrganizations();
      setOrganizations(orgData);
      if (orgData.length > 0) {
        setActiveOrgId(String(orgData[0].id));
      }
    }
    loadOrganizations();
  }, []);

  useEffect(() => {
    if (!activeOrgId) return;
    async function loadBatches() {
      setLoadingBatches(true);
      const batchData = await getBatches(activeOrgId);
      setBatches(batchData);
      setSelectedBatchId(batchData.length > 0 ? batchData[0].id : null);
      setLoadingBatches(false);
    }
    loadBatches();
  }, [activeOrgId]);

  useEffect(() => {
    if (!activeOrgId || !selectedBatchId) {
      setRecords([]);
      return;
    }
    async function loadRecords() {
      setLoadingRecords(true);
      const recordData = await getRecords({ orgId: activeOrgId, batchId: selectedBatchId });
      setRecords(recordData);
      setLoadingRecords(false);
    }
    loadRecords();
  }, [activeOrgId, selectedBatchId]);

  const counters = useMemo(() => {
    const totalBatchesProcessed = batches.length;
    const cleanRecords = records.filter(
      (item) =>
        item.verification_status === "PENDING_REVIEW" ||
        item.verification_status === "APPROVED_LOCKED"
    ).length;
    const pendingApprovals = records.filter((item) => item.verification_status === "PENDING_REVIEW").length;
    const anomalyFlags = records.filter(
      (item) => item.verification_status === "SUSPICIOUS" || item.verification_status === "VALIDATION_FAILED"
    ).length;

    return { totalBatchesProcessed, cleanRecords, pendingApprovals, anomalyFlags };
  }, [batches, records]);

  const filteredRecords = useMemo(() => {
    if (currentView === "anomaly") {
      return records.filter(
        (item) =>
          item.verification_status === "SUSPICIOUS" ||
          item.verification_status === "VALIDATION_FAILED"
      );
    }

    if (currentView === "ledger") {
      return records.filter((item) => item.verification_status === "APPROVED_LOCKED");
    }

    return records;
  }, [currentView, records]);

  const workspaceTitle = useMemo(() => {
    if (currentView === "anomaly") {
      return "Operational Anomaly Verification Queue";
    }
    if (currentView === "ledger") {
      return "Finalized Approval Ledger";
    }
    return "Analyst Data Workspace";
  }, [currentView]);

  const showBatchPanel = currentView === "workspace" || currentView === "batches";

  function appendAuditEvent(entry) {
    setAuditEvents((previous) => [entry, ...previous].slice(0, 200));
  }

  function setRecordLoading(recordId, isLoading) {
    setActionLoadingRecordIds((previous) => ({
      ...previous,
      [recordId]: isLoading,
    }));
  }

  async function handleApproveAndLock(record) {
    if (record.verification_status === "APPROVED_LOCKED") {
      return;
    }
    setRecordLoading(record.id, true);
    try {
      const updatedRecord = await approveRecord(record.id);
      setRecords((previous) =>
        previous.map((entry) => (entry.id === record.id ? { ...entry, ...updatedRecord } : entry))
      );
      appendAuditEvent({
        id: `approve-${record.id}-${Date.now()}`,
        recordId: record.id,
        timestamp: new Date().toISOString(),
        action: `Record #${record.id} Status changed to APPROVED_LOCKED`,
        operatorId,
        changeSummary: {
          verification_status: {
            from: record.verification_status,
            to: "APPROVED_LOCKED",
          },
          approved_by: operatorId,
          approved_at: new Date().toISOString(),
        },
      });
    } finally {
      setRecordLoading(record.id, false);
    }
  }

  async function handleFlagForReview(record, validationComment) {
    if (record.verification_status === "APPROVED_LOCKED") {
      return;
    }
    setRecordLoading(record.id, true);
    try {
      const updatedRecord = await flagRecord(record.id, validationComment);
      setRecords((previous) =>
        previous.map((entry) => {
          if (entry.id !== record.id) {
            return entry;
          }
          const existingErrors = Array.isArray(entry.validation_errors)
            ? entry.validation_errors
            : [];
          const existingRawErrors = Array.isArray(entry.raw_record?.validation_errors)
            ? entry.raw_record.validation_errors
            : [];
          const responseErrors = Array.isArray(updatedRecord.validation_errors)
            ? updatedRecord.validation_errors
            : [];
          const responseRawErrors = Array.isArray(updatedRecord.raw_record?.validation_errors)
            ? updatedRecord.raw_record.validation_errors
            : [];
          const mergedValidationErrors = [
            ...existingErrors,
            ...existingRawErrors,
            ...responseErrors,
            ...responseRawErrors,
            validationComment
          ].filter(
            (value, index, sourceArray) => sourceArray.indexOf(value) === index && typeof value === 'string' && value.trim() !== ''
          );
          const nextRawRecord = {
            ...entry.raw_record,
            ...(updatedRecord.raw_record || {}),
            status: "SUSPICIOUS",
            validation_errors: mergedValidationErrors,
          };
          return {
            ...entry,
            ...updatedRecord,
            verification_status: "SUSPICIOUS",
            validation_errors: mergedValidationErrors,
            raw_record: nextRawRecord,
          };
        })
      );
      const isSameStatusOverride = record.verification_status === "SUSPICIOUS";
      const auditActionLabel = isSameStatusOverride
        ? `Analyst validation override appended to Record #${record.id}`
        : `Record #${record.id} Status changed to SUSPICIOUS`;
      appendAuditEvent({
        id: `flag-${record.id}-${Date.now()}`,
        recordId: record.id,
        timestamp: new Date().toISOString(),
        action: auditActionLabel,
        operatorId,
        changeSummary: {
          verification_status: {
            from: record.verification_status,
            to: "SUSPICIOUS",
          },
          appended_validation_error: validationComment,
        },
      });
    } finally {
      setRecordLoading(record.id, false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-950/90 shadow-lg shadow-black/30 backdrop-blur">
        <div className="mx-auto flex w-full max-w-full flex-col gap-4 px-8 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-zinc-100">Breathe ESG Operations Workspace</h1>
            <p className="text-sm text-zinc-400">
              Multi-tenant emissions audit dashboard with ingestion and anomaly oversight.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <label htmlFor="tenant-selector" className="text-sm font-semibold text-zinc-300">
              Active Tenant
            </label>
            <select
              id="tenant-selector"
              value={activeOrgId}
              onChange={(event) => setActiveOrgId(event.target.value)}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-100 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
            >
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-full grid-cols-1 gap-6 px-8 py-6 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4 shadow-xl shadow-black/20">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">Navigation</h2>
          <nav className="space-y-2 text-sm">
            <SidebarNavButton
              label="Analyst Workspace"
              isActive={currentView === "workspace"}
              onClick={() => setCurrentView("workspace")}
            />
            <SidebarNavButton
              label="Batches"
              isActive={currentView === "batches"}
              onClick={() => setCurrentView("batches")}
            />
            <SidebarNavButton
              label="Anomaly Queue"
              isActive={currentView === "anomaly"}
              onClick={() => setCurrentView("anomaly")}
            />
            <SidebarNavButton
              label="Approval Ledger"
              isActive={currentView === "ledger"}
              onClick={() => setCurrentView("ledger")}
            />
          </nav>
        </aside>

        <section className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Total Batches Processed" value={counters.totalBatchesProcessed} />
            <MetricCard label="Clean Records" value={counters.cleanRecords} tone="emerald" />
            <MetricCard label="Pending Approvals" value={counters.pendingApprovals} tone="amber" />
            <MetricCard label="Anomaly Flags" value={counters.anomalyFlags} tone="rose" />
          </div>

          {currentView === "batches" ? (
            <PipelineHistoryView
              batches={batches}
              onSelectBatch={setSelectedBatchId}
              setCurrentView={setCurrentView}
            />
          ) : (
            <div
              className="transition-all duration-300 ease-out flex flex-col xl:flex-row gap-6 w-full"
            >
              {currentView === "workspace" ? (
                <div className="w-full xl:w-96 shrink-0">
                  <BatchSelectionPanel
                    batches={batches}
                    selectedBatchId={selectedBatchId}
                    onSelectBatch={setSelectedBatchId}
                    isLoading={loadingBatches}
                  />
                </div>
              ) : null}
              <div className="flex-1 min-w-0 w-full">
                <DataWorkspaceGrid
                  records={filteredRecords}
                  selectedBatchId={selectedBatchId}
                  isLoading={loadingRecords}
                  sectionTitle={workspaceTitle}
                  currentView={currentView}
                  onApproveAndLock={handleApproveAndLock}
                  onFlagForReview={handleFlagForReview}
                  actionLoadingRecordIds={actionLoadingRecordIds}
                />
              </div>
            </div>
          )}

          <AuditTrailLedger events={auditEvents} />
        </section>
      </main>
    </div>
  );
}

function SidebarNavButton({ label, isActive, onClick }) {
  const className = isActive
    ? "w-full rounded-md border border-emerald-500/40 bg-emerald-600/20 px-3 py-2 text-left font-semibold text-emerald-300"
    : "w-full rounded-md border border-transparent px-3 py-2 text-left text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-800/80";

  return (
    <button type="button" className={className} onClick={onClick}>
      {label}
    </button>
  );
}

function MetricCard({ label, value, tone = "slate" }) {
  const toneClassByType = {
    slate: "border-zinc-800 bg-zinc-900/80 text-zinc-100",
    emerald: "border-emerald-500/30 bg-emerald-600/10 text-emerald-200",
    amber: "border-amber-500/30 bg-amber-600/10 text-amber-200",
    rose: "border-rose-500/30 bg-rose-600/10 text-rose-200",
  };

  return (
    <article className={`rounded-xl border p-4 shadow-sm ${toneClassByType[tone] || toneClassByType.slate}`}>
      <h3 className="text-xs font-semibold uppercase tracking-wide">{label}</h3>
      <p className="mt-2 text-3xl font-bold">{value}</p>
    </article>
  );
}

/**
 * exportAuditTrailTxt
 * Serialises the full audit event log to a human-readable compliance text
 * block and triggers an instant browser download — zero external dependencies.
 */
function exportAuditTrailTxt(events) {
  const SEPARATOR = "=" .repeat(72);
  const lines = [
    "BREATHE ESG — IMMUTABLE AUDIT TRAIL COMPLIANCE LOG",
    `Exported at: ${new Date().toISOString()}`,
    `Total events: ${events.length}`,
    SEPARATOR,
  ];

  events.forEach((event, index) => {
    let displayAction = event.action;
    if (event.changeSummary?.verification_status) {
      const { from, to } = event.changeSummary.verification_status;
      const recId = event.recordId || String(event.id).split("-")[1];
      displayAction =
        from === to
          ? `Analyst validation override appended to Record #${recId}`
          : `Record #${recId} Status changed to ${to}`;
    }

    lines.push(
      `[${index + 1}] ${new Date(event.timestamp).toISOString()}`,
      `Action   : ${displayAction}`,
      `Operator : ${event.operatorId}`,
      `Delta    :`,
      JSON.stringify(event.changeSummary, null, 2)
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n"),
      SEPARATOR
    );
  });

  const content = lines.join("\n");
  const blob = new Blob([content], { type: "text/plain;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "immutable_sustainability_audit_trail.txt";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/**
 * exportAuditLedgerExcel
 * Flattens structured audit event objects into a 7-column SheetJS workbook
 * and triggers an instant native .xlsx browser download.
 *
 * Columns:
 *   Timestamp | Action Description | Operator Email |
 *   Field Modified | Previous Value | Updated Value | Analyst Custom Comments
 */
function exportAuditLedgerExcel(events) {
  const sheetData = events.map((event) => {
    // ── Resolve human-readable action label (mirrors AuditTrailLedger display) ──
    let displayAction = event.action || "";
    const vs = event.changeSummary?.verification_status;
    if (vs) {
      const recId = event.recordId || String(event.id).split("-")[1];
      displayAction =
        vs.from === vs.to
          ? `Analyst validation override appended to Record #${recId}`
          : `Record #${recId} Status changed to ${vs.to}`;
    }

    // ── Flatten nested changeSummary into flat spreadsheet columns ──
    const fieldModified = vs
      ? "verification_status"
      : Object.keys(event.changeSummary || {}).join("; ");
    const previousValue = vs ? (vs.from ?? "") : "";
    const updatedValue  = vs ? (vs.to   ?? "") : "";
    const analystComments = event.changeSummary?.appended_validation_error ?? "";

    return {
      "Timestamp":               new Date(event.timestamp).toISOString(),
      "Action Description":      displayAction,
      "Operator Email":          event.operatorId,
      "Field Modified":          fieldModified,
      "Previous Value":          previousValue,
      "Updated Value":           updatedValue,
      "Analyst Custom Comments": analystComments,
    };
  });

  const worksheet = XLSX.utils.json_to_sheet(sheetData);
  const workbook  = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Audit Trail");
  XLSX.writeFile(workbook, "sustainability_compliance_audit_ledger.xlsx");
}

function AuditTrailLedger({ events }) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-4 shadow-xl shadow-black/20">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Audit Trail Ledger</h2>
          <span className="text-xs text-zinc-400">Real-time action timeline</span>
        </div>

        {/* Export action buttons — only rendered once there are events */}
        {events.length > 0 && (
          <div className="flex items-center gap-2">
            {/* ── Plain-text compliance log ── */}
            <button
              type="button"
              onClick={() => exportAuditTrailTxt(events)}
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-zinc-200 shadow-sm transition hover:border-emerald-500/60 hover:bg-zinc-700 hover:text-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
              title="Download the full audit trail as a human-readable compliance .txt log"
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
              ↓ Download Log (.txt)
            </button>

            {/* ── Excel-compatible flattened SheetJS ledger ── */}
            <button
              type="button"
              onClick={() => exportAuditLedgerExcel(events)}
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-zinc-200 shadow-sm transition hover:border-emerald-500/60 hover:bg-zinc-700 hover:text-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
              title="Export the audit ledger as a flat, native Excel .xlsx file"
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
              Export Logs (Excel)
            </button>
          </div>
        )}
      </div>

      {events.length === 0 ? (
        <p className="text-sm text-zinc-400">No analyst actions captured yet.</p>
      ) : (
        <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
          {events.map((event) => {
            let displayAction = event.action;
            if (event.changeSummary?.verification_status) {
              const { from, to } = event.changeSummary.verification_status;
              const recId = event.recordId || event.id.split("-")[1];
              if (from === to) {
                displayAction = `Analyst validation override appended to Record #${recId}`;
              } else {
                displayAction = `Record #${recId} Status changed to ${to}`;
              }
            }
            return (
              <article key={event.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
                <p className="text-xs text-zinc-400">{new Date(event.timestamp).toLocaleString()}</p>
                <p className="mt-1 text-sm font-semibold text-zinc-100">{displayAction}</p>
                <p className="mt-1 text-xs text-zinc-300">Operator: {event.operatorId}</p>
                <pre className="mt-2 overflow-x-auto rounded bg-slate-900 p-2 text-xs text-emerald-200">
                  {JSON.stringify(event.changeSummary, null, 2)}
                </pre>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function PipelineHistoryView({ batches, onSelectBatch, setCurrentView }) {
  return (
    <section className="space-y-6 w-full rounded-xl border border-zinc-800 bg-zinc-950/90 p-6 shadow-2xl shadow-black/30 backdrop-blur">
      <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-zinc-100">
            Enterprise Data Ingestion & Pipeline History
          </h2>
          <p className="text-sm text-zinc-400">
            Authoritative ingestion log, processing telemetry, and validation health scores.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {batches.map((batch) => {
          const total = Number(batch.total_records || 0);
          const successful = Number(batch.successful_entries || 0);
          const suspicious = Number(batch.suspicious_flags || 0);
          const failed = Math.max(total - successful - suspicious, 0);
          const cleanPercent = total > 0 ? Math.round((successful / total) * 100) : 0;

          return (
            <article
              key={batch.id}
              className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-xl shadow-black/20 transition hover:border-zinc-700 hover:bg-zinc-900"
            >
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div className="space-y-2 flex-1">
                  <div className="flex flex-wrap items-center gap-3">
                    <span
                      className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
                        batch.source_type_badge_class || "bg-zinc-800 text-zinc-200 border border-zinc-700"
                      }`}
                    >
                      {batch.source_type}
                    </span>
                    <span className="text-sm font-semibold text-zinc-300">
                      Batch #{batch.id}
                    </span>
                    <span className="text-xs text-zinc-500">
                      • Ingested {new Date(batch.ingested_at).toLocaleString()}
                    </span>
                  </div>
                  <h3 className="text-base font-bold text-zinc-100 truncate max-w-xl">
                    {batch.file_name}
                  </h3>
                  <div className="text-xs text-zinc-400">
                    Total Rows: <span className="font-semibold text-zinc-200">{total}</span>
                    {"  "}•{"  "}
                    Clean: <span className="font-semibold text-emerald-400">{successful}</span>
                    {"  "}•{"  "}
                    Suspicious: <span className="font-semibold text-amber-400">{suspicious}</span>
                    {"  "}•{"  "}
                    Failed: <span className="font-semibold text-rose-400">{failed}</span>
                  </div>
                </div>

                <div className="flex flex-col gap-2 min-w-[280px]">
                  <div className="flex items-center justify-between text-xs font-semibold text-zinc-300">
                    <span>Pipeline Ingestion Health</span>
                    <span className="text-emerald-400">{cleanPercent}%</span>
                  </div>
                  <div className="h-2.5 w-full overflow-hidden rounded-full bg-zinc-800 border border-zinc-700">
                    <div className="flex h-full">
                      <div className="h-full bg-emerald-500" style={{ width: `${cleanPercent}%` }} />
                      <div className="h-full bg-rose-500" style={{ width: `${100 - cleanPercent}%` }} />
                    </div>
                  </div>
                  <span className="text-[11px] text-zinc-400">
                    {cleanPercent}% of data parsed successfully without system exceptions.
                  </span>
                </div>

                <div className="flex items-center justify-end pl-4">
                  <button
                    type="button"
                    onClick={() => {
                      onSelectBatch(batch.id);
                      setCurrentView("workspace");
                    }}
                    className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-500 transition shadow-emerald-950/30"
                  >
                    Investigate Batch
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

