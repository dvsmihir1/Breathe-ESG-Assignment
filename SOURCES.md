# Breathe ESG Prototype - Source Format Research Notes

This document records the real-world format assumptions we encoded into the prototype ingestion engines and mock datasets. It is intentionally explicit so reviewers can compare parser behavior against expected enterprise payload shapes.

---

## 1) SAP Data (Flat-File / CSV Exports)

## Why This Shape Was Simulated

The SAP ingestion path (`SAPIngestionEngine`) was implemented around enterprise flat-file patterns with localized German headers common in EU deployments:

- `Menge` (quantity)
- `ME` (unit of measure)
- `Werk` (plant code)
- `Buchungsdatum` (posting date)

The parser also supports alternate aliases (`Quantity`, `Unit`, `PostingDate`) to tolerate mixed export templates.

The engine includes:

- locale-aware numeric cleanup (`1.234,56` -> `1234.56`),
- flexible date parsing (`%d.%m.%Y`, `%Y-%m-%d`, etc.),
- internal plant code mapping dictionary to facility names,
- Scope classification:
  - fuel-like activities -> Scope 1,
  - procurement/default -> Scope 3.

## Realistic Sample SAP Payload

```csv
Werk,Menge,ME,Buchungsdatum,ActivityType,MaterialGroup,DocumentNumber
P100A,"1.234,56",L,14.05.2026,diesel,fuel,5100049281
DE-LEG-01,"800,00",EUR,2026/05/13,procurement,indirect_spend,5100049282
P200B,"540,10",L,13.05.2026,gasoline,fuel,5100049283
P300C,"1.050,00",EUR,12.05.2026,procurement,capex,5100049284
```

## What Breaks in Live Deployment

- Custom SAP layouts can rename or omit expected columns.
- Legacy plant codes may not exist in mapping dictionary.
- Regional decimal/date conventions can vary by export locale.
- Some exports may include semicolon delimiters or quoted anomalies.

Mitigation path:

- configurable per-tenant header maps,
- managed plant code registry UI/API,
- parser profile versioning with test fixtures per SAP environment.

---

## 2) Utility Portal Data (Metered Electricity CSV)

## Why This Shape Was Simulated

Utility portal exports are often semi-standardized CSV files with:

- meter identifier fields (`meter_id`, `MeterID`, `UtilityMeter`),
- consumption metrics in mixed units (`Wh`, `kWh`, `MWh`),
- non-calendar billing periods (`BillingStart`, `BillingEnd`).

The implemented engine (`UtilityPortalEngine`) explicitly:

- extracts meter IDs,
- converts units to canonical kWh,
- stores billing start and end dates on normalized records,
- flags overlaps and anomalies via status logic.

## Realistic Sample Utility Payload

```csv
MeterID,Consumption,Unit,BillingStart,BillingEnd,ServiceAddress,TariffCode
MTR-DE-BER-7781,4200,kWh,12/11/2025,14/12/2025,Berlin Plant Main,COM-HT-01
MTR-DE-BER-7781,9800,kWh,2025-12-10,2026-01-12,Berlin Plant Main,COM-HT-01
MTR-DE-MUC-1140,1250000,Wh,2025-11-01,2025-11-30,Munich DC,COM-MT-07
MTR-DE-HAM-2240,3.2,MWh,2025-10-15,2025-11-14,Hamburg Site,COM-LT-02
```

## What Breaks in Live Deployment

- Portal vendors may silently alter column names/order.
- Billing window fields may be missing or malformed.
- Meter IDs can be masked/truncated by export permissions.
- Timezone treatment of billing boundaries may be inconsistent.

Mitigation path:

- schema drift detection tests on ingestion,
- strict null/format alerting with ingestion quarantine,
- per-provider adapter layer instead of one generic parser.

---

## 3) Corporate Travel Data (Nested JSON API)

## Why This Shape Was Simulated

The travel engine (`CorporateTravelEngine`) mirrors corporate API payloads (Concur-like) where:

- trip entries are nested objects,
- flight records may provide only origin/destination IATA codes,
- ground/hotel events carry different quantity semantics.

Implemented logic:

- mode isolation for `flight`, `hotel`, `ground_transport`,
- internal airport coordinate lookup for common IATA codes,
- Haversine distance calculation for flight kilometers,
- Scope 3 mapping with mode-specific factors.

## Realistic Sample Travel Payload

```json
{
  "tenant": "Breathe ESG - Europe Division",
  "source_system": "SAP Concur",
  "trips": [
    {
      "type": "flight",
      "origin_iata": "JFK",
      "destination_iata": "BLR",
      "start_date": "2026-04-02",
      "end_date": "2026-04-03",
      "traveler_id": "EMP-11820",
      "ticket_class": "ECONOMY"
    },
    {
      "type": "hotel",
      "nights": 3,
      "start_date": "2026-04-03",
      "end_date": "2026-04-06",
      "city_code": "BLR",
      "traveler_id": "EMP-11820"
    },
    {
      "type": "ground_transport",
      "distance_km": 28,
      "start_date": "2026-04-04",
      "end_date": "2026-04-04",
      "provider": "Taxi Fleet A",
      "traveler_id": "EMP-11820"
    }
  ]
}
```

## Haversine Logic Notes

When only IATA tags are present:

1. map each airport code to latitude/longitude,
2. compute great-circle distance using Haversine,
3. use resulting kilometers as normalized flight activity quantity.

This approach is deterministic and sufficient for prototype-grade route estimation.

## What Breaks in Live Deployment

- Multi-leg itineraries need segment-level reconstruction.
- Codeshare flights may hide actual operating route.
- Airport code lookups can be incomplete or stale.
- Non-flight travel modes can use inconsistent unit semantics.

Mitigation path:

- itinerary segment model with per-leg calculations,
- external airport metadata refresh pipeline,
- vendor-specific travel adapters with robust schema contracts.

---

## Cross-Source Reliability Summary

Across SAP, Utility, and Travel ingestion, the major production risk is **schema drift** rather than core arithmetic.

Current prototype posture addresses this by:

- preserving immutable raw payloads for replay,
- classifying uncertain rows as `SUSPICIOUS` / `VALIDATION_FAILED`,
- and surfacing analyst controls with audit traceability before lock approval.

This keeps the system reviewable even when source quality degrades.
