# Breathe ESG Prototype - Data Model Architecture

## Scope

This document describes the implemented Django schema in `emissions_tracker/models.py` and how it enforces:

- strict tenant data isolation,
- immutable raw-vs-normalized data boundaries,
- auditable workflow transitions,
- and permanent record locking for approved emissions results.

The implementation is intentionally opinionated for a compliance-oriented prototype, not a generic CRUD model.

---

## Entity Overview

The current schema includes:

1. `Organization`
2. `IngestionBatch`
3. `RawDataRecord`
4. `NormalizedEmissionRecord`
5. `AuditTrail`

Additional enums in code:

- `EmissionsWorkflowStatus`: `RAW`, `PENDING_REVIEW`, `SUSPICIOUS`, `VALIDATION_FAILED`, `APPROVED_LOCKED`
- `SourceType`: `SAP`, `UTILITY`, `TRAVEL`
- `ScopeCategory`: `SCOPE_1`, `SCOPE_2`, `SCOPE_3`

---

## Multi-Tenancy Strategy

## Structural Isolation Rule

All operational models except `Organization` carry a **mandatory** `organization` foreign key:

- `IngestionBatch.organization` (required)
- `RawDataRecord.organization` (required)
- `NormalizedEmissionRecord.organization` (required)
- `AuditTrail.organization` (required)

This is not only a UI or query convention. The data model itself encodes tenant ownership on every mutable operational record.

## Cross-Model Tenant Integrity

The model layer enforces tenant consistency:

- `RawDataRecord.clean()` verifies `raw_record.organization == batch.organization`.
- `NormalizedEmissionRecord.clean()` verifies `normalized.organization == raw_record.organization`.

If these conditions fail, model validation raises `ValidationError`, blocking persistence.

This means a valid row cannot be accidentally attached to another tenant’s batch or source record, even if an upstream service is buggy.

## Query-Side Tenant Gating

The DRF view layer (`emissions_tracker/views.py`) requires tenant selectors (`org_id` query parameter or `X-Organization-Id`) and filters querysets by `organization_id` before object access.

Combined with mandatory organization foreign keys, this gives:

- schema-level ownership,
- validation-level consistency checks,
- endpoint-level scoping.

---

## Raw vs Normalized Separation

## `RawDataRecord` (Source of Truth Evidence)

Purpose:

- Store imported source payload exactly as captured (`raw_payload` JSONField).
- Persist parse/validation diagnostics (`validation_errors` JSONField).
- Preserve immutable evidence for forensic replay and audit.

Key fields:

- `batch` (FK to ingestion envelope)
- `organization` (tenant owner)
- `raw_payload` (original source row/object)
- `status` (`EmissionsWorkflowStatus`)
- `validation_errors` (list-like JSON)

## `NormalizedEmissionRecord` (Computed Accounting Artifact)

Purpose:

- Store transformed, standardized and factorized emissions values ready for analyst workflow.

Key fields:

- `raw_record` (FK back to source evidence)
- `organization` (same tenant as raw record)
- `scope_category`, `activity_type`
- raw metrics (`raw_quantity`, `raw_unit`)
- normalized metrics (`normalized_quantity`, `normalized_unit`)
- factor + carbon (`emissions_factor`, `calculated_co2e_kg`)
- billing window (`billing_start_date`, `billing_end_date`)
- review controls (`verification_status`, `approved_by`, `approved_at`)

## Why This Split Matters

Without separation, corrections/reprocessing can overwrite source evidence and destroy audit traceability.

With this split:

- Raw payload remains historical truth.
- Normalized output can be recomputed with updated rules.
- Analysts can compare original data and computed values side-by-side in the frontend grid.

---

## Workflow State Machine

Implemented canonical states:

- `RAW`
- `PENDING_REVIEW`
- `SUSPICIOUS`
- `VALIDATION_FAILED`
- `APPROVED_LOCKED`

Ingestion engines initially classify records based on deterministic validation/anomaly logic.

### Practical Lifecycle

Typical path:

1. Record arrives as `RAW` or directly `PENDING_REVIEW` after parsing.
2. Validation/anomaly checks may classify as:
   - `SUSPICIOUS` (e.g., historical spike or overlap),
   - `VALIDATION_FAILED` (e.g., invalid/negative/unparseable fields).
3. Analyst can eventually approve a record.
4. Approved record becomes `APPROVED_LOCKED` and then immutable.

---

## Immutability Guarantees for Approved Data

`NormalizedEmissionRecord` implements two hard controls:

1. `save()` override:
   - On update (`self.pk` exists), fetches persisted record.
   - If existing status is `APPROVED_LOCKED`, raises `ValidationError`.
   - Any further mutation is rejected.

2. `delete()` override:
   - If current status is `APPROVED_LOCKED`, raises `ValidationError`.
   - Deletion of locked records is blocked.

Additional behavior:

- In `clean()`, when status transitions to `APPROVED_LOCKED` and `approved_at` missing, timestamp is set.

This creates a model-level tamper barrier independent of UI controls.

---

## AuditTrail Ledger Schema

`AuditTrail` captures tenant-scoped action events:

- `organization` (owner)
- `record_id` (target record identifier)
- `action_taken` (semantic action, e.g., `APPROVE_RECORD`, `FLAG_RECORD`)
- `executed_by` (actor FK to auth user)
- `timestamp` (auto_now_add)
- `changes_json` (structured before/after payload)

Indexes prioritize:

- time-ordered tenant review (`organization`, `timestamp`)
- record-centric trace lookup (`organization`, `record_id`)

In the frontend prototype, an additional in-memory timeline mirrors these events in real time so analysts can see action history immediately while backend audit entries persist authoritative state.

---

## Current Compliance Posture

This schema already supports:

- tenant boundary enforcement at DB and API layers,
- deterministic review-state workflow,
- immutable approval locking,
- evidence-preserving raw payload storage,
- and traceable ledger events.

For production hardening, add:

- database constraints for cross-model tenant equality where possible,
- immutable append-only audit storage policy,
- and permission-tiered approval roles.
