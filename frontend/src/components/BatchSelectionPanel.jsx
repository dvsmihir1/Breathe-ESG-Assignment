import React from "react";

/**
 * BatchSelectionPanel
 *
 * Renders tenant-scoped ingestion batches with source badges, metadata,
 * and quality progress bars so auditors can quickly select investigation scope.
 */
export default function BatchSelectionPanel({
  batches,
  selectedBatchId,
  onSelectBatch,
  isLoading,
}) {
  if (isLoading) {
    return (
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-4 shadow-xl shadow-black/20">
        <h2 className="mb-4 text-lg font-semibold text-zinc-100">Ingestion Batch History</h2>
        <p className="text-sm text-zinc-400">Loading tenant batches...</p>
      </section>
    );
  }

  if (!batches || batches.length === 0) {
    return (
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-4 shadow-xl shadow-black/20">
        <h2 className="mb-4 text-lg font-semibold text-zinc-100">Ingestion Batch History</h2>
        <p className="text-sm text-zinc-400">No batches are available for this organization.</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-4 shadow-xl shadow-black/20">
      <h2 className="mb-4 text-lg font-semibold text-zinc-100">Ingestion Batch History</h2>
      <div className="space-y-3">
        {batches.map((batch) => {
          const total = Number(batch.total_records || 0);
          const successful = Number(batch.successful_entries || 0);
          const suspicious = Number(batch.suspicious_flags || 0);
          const failed = Math.max(total - successful - suspicious, 0);
          const cleanPercent = total > 0 ? Math.round((successful / total) * 100) : 0;
          const issuePercent = total > 0 ? 100 - cleanPercent : 0;
          const selected = Number(selectedBatchId) === Number(batch.id);

          return (
            <button
              key={batch.id}
              type="button"
              onClick={() => onSelectBatch(batch.id)}
              className={`w-full rounded-lg border p-4 text-left transition ${
                selected
                  ? "border-emerald-500/50 bg-emerald-700/20 ring-2 ring-emerald-500/20"
                  : "border-zinc-800 bg-zinc-950/70 hover:border-zinc-700 hover:bg-zinc-900"
              }`}
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <span
                  className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
                    batch.source_type_badge_class || "bg-slate-100 text-slate-700"
                  }`}
                >
                  {batch.source_type}
                </span>
                <span className="text-xs text-zinc-400">
                  Batch #{batch.id} • {new Date(batch.ingested_at).toLocaleString()}
                </span>
              </div>

              <p className="mb-2 truncate text-sm font-medium text-zinc-100">{batch.file_name}</p>
              <p className="mb-3 text-xs text-zinc-300">
                Rows: {total} • Clean: {successful} • Suspicious: {suspicious} • Failed: {failed}
              </p>

              <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                <div className="flex h-full">
                  <div className="h-full bg-emerald-500" style={{ width: `${cleanPercent}%` }} />
                  <div className="h-full bg-rose-500" style={{ width: `${issuePercent}%` }} />
                </div>
              </div>
              <p className="mt-2 text-xs font-medium text-zinc-300">
                Clean Ratio: {cleanPercent}% / Issues: {issuePercent}%
              </p>
            </button>
          );
        })}
      </div>
    </section>
  );
}

