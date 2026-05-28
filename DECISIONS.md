# Breathe ESG Prototype - Engineering Decisions Log

## Context

This prototype was built under a compressed timeline with explicit goals:

- prove end-to-end ingestion from heterogeneous enterprise formats,
- preserve auditability and tenant isolation,
- and ship an interactive analyst workflow in React.

The implementation reflects practical constraints, not an exhaustive enterprise ESG platform.

---

## Ambiguities Resolved During Implementation

## 1) Status Taxonomy and Ownership

Ambiguity:

- Should status live only on normalized records, or also on raw artifacts and batches?

Decision:

- Keep workflow status on **all operational layers**:
  - `IngestionBatch.status`
  - `RawDataRecord.status`
  - `NormalizedEmissionRecord.verification_status`

Reason:

- Batch-level health and row-level validation can diverge.
- Raw and normalized artifacts must independently communicate state to auditors and engineers.

## 2) Tenant Isolation Enforcement Layer

Ambiguity:

- Rely on frontend org selection only, or enforce in backend schema and API?

Decision:

- Enforce in multiple layers:
  - mandatory FK `organization` on non-root entities,
  - model `clean()` consistency checks,
  - DRF queryset tenant filtering requiring `org_id` or `X-Organization-Id`.

Reason:

- UI-only tenancy is fragile and unsafe.
- Structural tenancy lowers risk of accidental cross-tenant joins.

## 3) Data Model Split

Ambiguity:

- Store source payload and computed metrics in one row vs. split models.

Decision:

- Separate `RawDataRecord` and `NormalizedEmissionRecord`.

Reason:

- Source evidence must remain immutable.
- Normalization logic can evolve without rewriting historical source payloads.

## 4) Prototype Factors and Unit Strategy

Ambiguity:

- Integrate external factor API immediately vs. hardcode deterministic factors.

Decision:

- Use explicit code-level factors for deterministic prototype behavior.

Reason:

- Removes runtime dependency risk during validation demos.
- Keeps discrepancies reproducible while anomaly logic is being tested.

## 5) Frontend Interaction Model

Ambiguity:

- Static analytical table vs. interactive reviewer controls.

Decision:

- Add action controls (`Approve & Lock`, `Flag for Review`) with immediate state updates and a real-time audit feed.

Reason:

- Demonstrates analyst loop end-to-end, including immutable lock behavior.

---

## Data Subsets Implemented vs Deliberately Deferred

## Implemented in Prototype

- SAP flat-file style parsing with German headers:
  - `Menge`, `ME`, `Werk`, `Buchungsdatum`
- Legacy plant code mapping dictionary to facilities.
- Utility CSV ingestion:
  - meter extraction,
  - non-calendar billing windows,
  - `Wh/kWh/MWh` conversion to canonical kWh.
- Corporate travel JSON:
  - flight/hotel/ground transport modes,
  - IATA code lookup,
  - Haversine distance for flights.
- Workflow states:
  - `PENDING_REVIEW`, `SUSPICIOUS`, `VALIDATION_FAILED`, `APPROVED_LOCKED`.
- Anomaly checks:
  - >200% historical average for exact activity type,
  - overlapping billing windows.

## Deliberately Deferred

- Market-based electricity accounting with contractual instruments (RECs, PPAs, residual mix).
- Granular Scope 3 lifecycle categories beyond implemented travel/procurement proxies.
- Jurisdiction-aware factor registries and versioned factor provenance.
- Currency conversion pipelines for procurement normalization.
- Supplier-level carbon intensity reconciliation.
- Full multi-leg itinerary handling and cabin-class-specific aviation factors.

---

## PM Questions We Would Ask Next

If PM availability existed during the build window, these are the exact follow-up questions:

1. **ERP Connectivity**  
   Are SAP inputs file-drop only, or do we need direct RFC/OData/API integration with retry/backfill semantics?

2. **Tenant Boundary Policy**  
   Is tenant isolation at legal-entity level, business-unit level, or both? Can a user operate across multiple orgs in one session?

3. **Factor Governance**  
   Which factor authority is canonical per region (DEFRA, EPA, IEA, local regulators), and how often do we re-baseline factors?

4. **Procurement Normalization**  
   Should procurement be normalized by currency, PPP-adjusted spend, weight, volume, or supplier-reported factors?

5. **Travel Semantics**  
   Do we need route reconstruction for layovers/codeshares, cabin class multipliers, and radiative forcing treatment?

6. **Approval Workflow**  
   Are approvals single-step or role-gated multi-step (analyst -> reviewer -> compliance sign-off)?

7. **Audit Export Requirements**  
   Which audit export format is required for external assurance (CSV/PDF/XBRL/API) and what evidence granularity is mandatory?

8. **Latency and Throughput Targets**  
   What ingestion SLA is expected per tenant and per file size tier (10k, 100k, 1M rows)?

9. **Data Retention Policy**  
   What are legal retention periods for raw payloads, normalized records, and audit entries by jurisdiction?

10. **Incident Response Constraints**  
    Who can unfreeze/rectify an approved record if correction is required? Is reversal append-only or editable with supervisory override?

---

## Why We Chose Service-Level Convenience Pipelines Over Celery

The prototype uses service-style processing (`ingestion_engines.py`) and convenience entrypoints instead of a distributed queue.

## Decision Rationale

- **Timeline Fit (4 days):**  
  We prioritized deterministic correctness and reviewability over infra complexity.

- **Debuggability:**  
  Synchronous request path made parser failures, validation states, and status transitions easy to inspect quickly.

- **Lower operational overhead:**  
  No broker provisioning (Redis/RabbitMQ), no worker deployment topology, no dead-letter strategy needed for PoC.

- **Reduced moving parts for demos:**  
  End-to-end flow remained observable from one API request through one response.

## Tradeoff Accepted

- Ingestion remains tied to request lifecycle and web-thread duration.
- For larger files or high concurrency, this must evolve to async jobs + progress tracking.

Given the PoC objective, the chosen architecture minimized failure surface while preserving migration path to background workers later.

---

## Forward Migration Path

When moving beyond prototype:

1. Keep current deterministic parsing modules.
2. Wrap them in asynchronous task envelopes (Celery/RQ/Arq).
3. Add durable job table and batch progress states.
4. Preserve current status and audit semantics unchanged.

This retains the core domain model while scaling execution infrastructure.
