# Breathe ESG Prototype - Intentional Tradeoffs

This document captures exactly three capabilities we intentionally did **not** build in the prototype, and why that was the correct decision for code clarity, security posture, and data integrity under a tight schedule.

---

## 1) Production-Grade IAM and OAuth2 Multi-Tenant Authentication

## What We Did Not Build

- Full enterprise identity federation (Auth0, Okta, Azure AD, custom IdP).
- OAuth2/OIDC token exchange flows.
- Tenant-aware JWT claims validation middleware.
- Role/permission matrix beyond baseline authentication assumptions.

## What We Built Instead

- Functional tenant scoping at the API layer:
  - `org_id` query parameter and/or `X-Organization-Id` header.
- Structural tenant ownership in DB schema:
  - mandatory `organization` FK on all non-root operational entities.
- Model-level tenant consistency checks.

## Why This Was Chosen

- In 4 days, introducing enterprise IAM would consume most engineering time and obscure domain validation goals.
- We needed deterministic ingestion, review-state transitions, and immutable locking first.
- Prototype success criteria were domain workflow correctness and analyst usability, not enterprise SSO rollout.

## Risks and Mitigations

- **Risk:** Header/query tenant selectors are not equivalent to full authZ in production.
- **Mitigation:** Current scoping provides defensive shape; production must add authenticated identity + tenant claims enforcement before real data onboarding.

---

## 2) Dynamic Emission Factor Lookup API Integration

## What We Did Not Build

- External live factor API integration (for example Climatiq-like lookups).
- Region/date-aware factor versioning fetch at runtime.
- API key rotation, quota management, fallback hierarchy, and provenance reconciliation.

## What We Built Instead

- Explicit in-code factors in ingestion engines:
  - electricity grid factor,
  - travel mode factors,
  - fuel/procurement prototype factors.

## Why This Was Chosen

- Eliminates external dependency failures during demos and validation cycles.
- Ensures deterministic outputs for anomaly rules and frontend verification.
- Avoids introducing uncertain latency and third-party downtime into critical parsing path.

## Risks and Mitigations

- **Risk:** Hardcoded factors can drift from regulatory updates.
- **Mitigation:** This is acceptable for PoC; production path is a governed factor registry with effective dates and auditable provenance metadata.

---

## 3) Automated Background File Splitting and Parsing Workers

## What We Did Not Build

- Queue-based asynchronous ingestion workers.
- File chunking/orchestration for very large uploads.
- Retry/dead-letter handling and distributed worker supervision.

## What We Built Instead

- Synchronous parsing and normalization in Django service modules (`ingestion_engines.py`).
- Immediate per-row status classification and persistence in request lifecycle.

## Why This Was Chosen

- Faster implementation and easier debugging in constrained schedule.
- Clear end-to-end observability from request to persisted records.
- Reduced infrastructure footprint for prototype setup.

## Operational Boundary for Prototype

Synchronous model is suitable for:

- small to medium files (for prototype, typically low tens of thousands of rows),
- controlled demo traffic,
- analyst-driven manual review cadence.

It is **not** the final architecture for:

- high concurrency multi-tenant imports,
- very large file bursts,
- strict ingestion latency SLAs under load.

## Forward Path

Promote current parsing engines into async workers without rewriting domain logic:

1. Keep parser classes and validation rules unchanged.
2. Wrap execution in queue tasks.
3. Add progress/status telemetry per batch.
4. Preserve immutable lock and audit semantics exactly as-is.

This protects code clarity now while leaving a clean scalability migration path later.
