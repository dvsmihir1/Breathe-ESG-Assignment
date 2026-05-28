"""
Deterministic ingestion engines for tenant-scoped emissions processing.

This module implements three production-style parsers:
- SAP flat-file ingestion with German enterprise headers and legacy mappings.
- Utility portal CSV ingestion with meter extraction and billing cycle handling.
- Corporate travel JSON ingestion with geospatial distance computation.

Audit-readiness design notes:
- Every write path enforces organization consistency between batch and records.
- Raw payloads are persisted separately from normalized emissions artifacts.
- Validation state is assigned per parsed row using strict, deterministic rules.

Conversion coefficients used here are explicit defaults and should be replaced by
governed factor catalogs in production:
- Electricity grid factor: 0.475 kg CO2e per kWh.
- Flight factor: 0.115 kg CO2e per passenger-km.
- Hotel factor: 15.000 kg CO2e per room-night.
- Ground transport factor: 0.180 kg CO2e per passenger-km.
- Diesel fuel factor: 2.680 kg CO2e per liter.
- Gasoline fuel factor: 2.310 kg CO2e per liter.
- Procurement spend proxy factor: 0.500 kg CO2e per EUR-equivalent unit.
"""

from __future__ import annotations

import csv
import io
import json
import math
import re
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Avg

from .models import (
    EmissionsWorkflowStatus,
    IngestionBatch,
    NormalizedEmissionRecord,
    Organization,
    RawDataRecord,
    ScopeCategory,
)


class IngestionEngineError(Exception):
    """Base exception for ingestion engine failures."""


class TenantMismatchError(IngestionEngineError):
    """Raised when a batch does not belong to the provided tenant."""


class ParsingError(IngestionEngineError):
    """Raised when an input document is structurally invalid."""


@dataclass
class ParsedRow:
    """Intermediate normalized row used before persistence."""

    raw_payload: dict[str, Any]
    activity_type: str
    raw_quantity: Decimal
    raw_unit: str
    normalized_quantity: Decimal
    normalized_unit: str
    emissions_factor: Decimal
    calculated_co2e_kg: Decimal
    billing_start_date: date | None
    billing_end_date: date | None
    scope_category: str
    metadata: dict[str, Any]
    status: str = EmissionsWorkflowStatus.PENDING_REVIEW
    validation_errors: list[str] | None = None


class BaseIngestionEngine:
    """Shared logic for tenant checks, validation, anomaly detection, and persistence."""

    HISTORICAL_MULTIPLIER_THRESHOLD = Decimal("2.0")

    def __init__(self, organization: Organization, batch: IngestionBatch):
        self.organization = organization
        self.batch = batch
        self._assert_tenant_consistency()

    def _assert_tenant_consistency(self) -> None:
        if self.batch.organization_id != self.organization.id:
            raise TenantMismatchError(
                "Batch organization does not match engine organization. "
                "Cross-tenant processing is blocked."
            )

    def process(self, payload: str) -> list[NormalizedEmissionRecord]:
        parsed_rows = self.parse_payload(payload)
        created_records: list[NormalizedEmissionRecord] = []
        for parsed_row in parsed_rows:
            self._assign_validation_status(parsed_row)
            created_records.append(self._persist_row(parsed_row))
        return created_records

    def parse_payload(self, payload: str) -> list[ParsedRow]:
        raise NotImplementedError("Subclasses must implement parse_payload.")

    def _assign_validation_status(self, parsed_row: ParsedRow) -> None:
        validation_errors = parsed_row.validation_errors or []

        if parsed_row.raw_quantity < 0 or parsed_row.normalized_quantity < 0:
            validation_errors.append("Negative quantity values are not allowed.")

        if parsed_row.billing_start_date is None or parsed_row.billing_end_date is None:
            validation_errors.append("Billing dates are unparseable or missing.")

        if validation_errors:
            parsed_row.status = EmissionsWorkflowStatus.VALIDATION_FAILED
            parsed_row.validation_errors = validation_errors
            return

        if self._is_suspicious_from_historical_average(parsed_row):
            parsed_row.status = EmissionsWorkflowStatus.SUSPICIOUS
            parsed_row.validation_errors = ["Value exceeds 200% of historical activity average."]
            return

        if self._has_overlapping_billing_window(parsed_row):
            parsed_row.status = EmissionsWorkflowStatus.SUSPICIOUS
            parsed_row.validation_errors = ["Detected overlapping billing window for activity key."]
            return

        parsed_row.status = EmissionsWorkflowStatus.PENDING_REVIEW
        parsed_row.validation_errors = []

    @staticmethod
    def _build_failed_row(
        raw_payload: dict[str, Any],
        error_message: str,
        activity_type: str,
        scope_category: str,
    ) -> ParsedRow:
        return ParsedRow(
            raw_payload=raw_payload,
            activity_type=activity_type,
            raw_quantity=Decimal("0"),
            raw_unit="UNKNOWN",
            normalized_quantity=Decimal("0"),
            normalized_unit="UNKNOWN",
            emissions_factor=Decimal("0"),
            calculated_co2e_kg=Decimal("0"),
            billing_start_date=None,
            billing_end_date=None,
            scope_category=scope_category,
            metadata={},
            status=EmissionsWorkflowStatus.VALIDATION_FAILED,
            validation_errors=[error_message],
        )

    def _is_suspicious_from_historical_average(self, parsed_row: ParsedRow) -> bool:
        historical_average = (
            NormalizedEmissionRecord.objects.filter(
                organization=self.organization,
                activity_type=parsed_row.activity_type,
            ).aggregate(avg_value=Avg("normalized_quantity"))["avg_value"]
            or Decimal("0")
        )
        if historical_average <= 0:
            return False
        threshold_value = Decimal(historical_average) * self.HISTORICAL_MULTIPLIER_THRESHOLD
        return parsed_row.normalized_quantity > threshold_value

    def _has_overlapping_billing_window(self, parsed_row: ParsedRow) -> bool:
        if parsed_row.billing_start_date is None or parsed_row.billing_end_date is None:
            return False

        return NormalizedEmissionRecord.objects.filter(
            organization=self.organization,
            activity_type=parsed_row.activity_type,
            billing_start_date__lte=parsed_row.billing_end_date,
            billing_end_date__gte=parsed_row.billing_start_date,
        ).exists()

    @transaction.atomic
    def _persist_row(self, parsed_row: ParsedRow) -> NormalizedEmissionRecord:
        effective_start_date = parsed_row.billing_start_date or self.batch.ingested_at.date()
        effective_end_date = parsed_row.billing_end_date or self.batch.ingested_at.date()

        raw_record = RawDataRecord.objects.create(
            batch=self.batch,
            organization=self.organization,
            raw_payload=parsed_row.raw_payload,
            status=parsed_row.status,
            validation_errors=parsed_row.validation_errors or [],
        )

        normalized_record = NormalizedEmissionRecord.objects.create(
            raw_record=raw_record,
            organization=self.organization,
            scope_category=parsed_row.scope_category,
            activity_type=parsed_row.activity_type,
            raw_quantity=parsed_row.raw_quantity,
            raw_unit=parsed_row.raw_unit,
            normalized_quantity=parsed_row.normalized_quantity,
            normalized_unit=parsed_row.normalized_unit,
            emissions_factor=parsed_row.emissions_factor,
            calculated_co2e_kg=parsed_row.calculated_co2e_kg,
            billing_start_date=effective_start_date,
            billing_end_date=effective_end_date,
            verification_status=parsed_row.status,
        )
        return normalized_record

    @staticmethod
    def _parse_decimal(raw_value: str | int | float | Decimal | None) -> Decimal:
        if raw_value is None:
            return Decimal("0")
        if isinstance(raw_value, Decimal):
            return raw_value
        if isinstance(raw_value, (int, float)):
            return Decimal(str(raw_value))

        cleaned_value = str(raw_value).strip()
        cleaned_value = cleaned_value.replace(" ", "")
        cleaned_value = cleaned_value.replace(".", "")
        cleaned_value = cleaned_value.replace(",", ".")
        cleaned_value = re.sub(r"[^0-9.\-]", "", cleaned_value)
        if cleaned_value in {"", "-", ".", "-."}:
            return Decimal("0")
        try:
            return Decimal(cleaned_value)
        except InvalidOperation as exc:
            raise ParsingError(f"Unable to parse numeric value: {raw_value}") from exc

    @staticmethod
    def _parse_flexible_date(raw_value: str | None) -> date | None:
        if not raw_value:
            return None
        candidate = str(raw_value).strip()
        formats = (
            "%Y-%m-%d",
            "%d.%m.%Y",
            "%d/%m/%Y",
            "%d-%m-%Y",
            "%m/%d/%Y",
            "%Y/%m/%d",
            "%d.%m.%y",
        )
        for date_format in formats:
            try:
                return datetime.strptime(candidate, date_format).date()
            except ValueError:
                continue
        return None


class SAPIngestionEngine(BaseIngestionEngine):
    """
    Parser for SAP flat-file/CSV inputs with enterprise German header variants.

    Parsing behaviors:
    - Supports header aliases including Menge (quantity), ME (unit of measure),
      Buchungsdatum (posting date), and legacy plant code fields.
    - Normalizes locale-formatted decimal values such as "1.234,56".
    - Maps legacy plant codes to deterministic facility labels.
    - Assigns Scope 1 for fuel activity and Scope 3 for procurement activity.
    """

    LEGACY_PLANT_CODE_TO_FACILITY = {
        "P100A": "Berlin Manufacturing Plant",
        "P200B": "Munich Distribution Hub",
        "P300C": "Hamburg Assembly Site",
        "DE-LEG-01": "Frankfurt Procurement Center",
    }
    FUEL_KEYWORDS = {"diesel", "gasoline", "natural_gas", "fuel_oil"}
    FACTOR_BY_ACTIVITY = {
        "diesel": Decimal("2.680"),
        "gasoline": Decimal("2.310"),
        "procurement": Decimal("0.500"),
    }

    def parse_payload(self, payload: str) -> list[ParsedRow]:
        if not payload.strip():
            raise ParsingError("SAP payload is empty.")

        reader = csv.DictReader(io.StringIO(payload))
        if not reader.fieldnames:
            raise ParsingError("SAP payload has no header row.")

        parsed_rows: list[ParsedRow] = []
        for row in reader:
            try:
                normalized_row = self._parse_row(row)
            except (ParsingError, ValidationError, KeyError, TypeError, ValueError) as exc:
                normalized_row = self._build_failed_row(
                    raw_payload=dict(row),
                    error_message=f"SAP parsing failure: {exc}",
                    activity_type="sap:unknown",
                    scope_category=ScopeCategory.SCOPE_3,
                )
            parsed_rows.append(normalized_row)
        return parsed_rows

    def _parse_row(self, row: dict[str, str]) -> ParsedRow:
        quantity = self._parse_decimal(row.get("Menge") or row.get("Quantity"))
        unit = (row.get("ME") or row.get("Unit") or "UNKNOWN").strip().upper()
        posting_date_raw = row.get("Buchungsdatum") or row.get("PostingDate")
        posting_date = self._parse_flexible_date(posting_date_raw)

        plant_code = (row.get("PlantCode") or row.get("Werk") or "UNMAPPED").strip()
        facility_name = self.LEGACY_PLANT_CODE_TO_FACILITY.get(plant_code, "Unknown Facility")

        material_group = (row.get("MaterialGroup") or row.get("Kategorie") or "").strip().lower()
        activity_descriptor = (row.get("ActivityType") or material_group or "procurement").strip().lower()

        if activity_descriptor in self.FUEL_KEYWORDS:
            scope_category = ScopeCategory.SCOPE_1
            emissions_factor = self.FACTOR_BY_ACTIVITY.get(activity_descriptor, Decimal("2.500"))
            normalized_unit = "L"
        else:
            scope_category = ScopeCategory.SCOPE_3
            emissions_factor = self.FACTOR_BY_ACTIVITY["procurement"]
            normalized_unit = "EUR_EQ"

        normalized_quantity = quantity
        calculated_co2e_kg = normalized_quantity * emissions_factor

        return ParsedRow(
            raw_payload=dict(row),
            activity_type=f"sap:{activity_descriptor}:{facility_name}",
            raw_quantity=quantity,
            raw_unit=unit,
            normalized_quantity=normalized_quantity,
            normalized_unit=normalized_unit,
            emissions_factor=emissions_factor,
            calculated_co2e_kg=calculated_co2e_kg,
            billing_start_date=posting_date,
            billing_end_date=posting_date,
            scope_category=scope_category,
            metadata={"facility_name": facility_name, "plant_code": plant_code},
            validation_errors=[],
        )


class UtilityPortalEngine(BaseIngestionEngine):
    """
    Parser for utility portal CSV exports focused on electricity consumption.

    Parsing behaviors:
    - Extracts meter identifiers from fields like meter_id/MeterID/UtilityMeter.
    - Converts mixed units (Wh, MWh, kWh) into canonical kWh.
    - Persists explicit billing period boundaries to support non-calendar cycles.
    - Applies Scope 2 electricity factor at 0.475 kg CO2e per kWh.
    """

    ELECTRICITY_GRID_FACTOR_KG_PER_KWH = Decimal("0.475")

    def parse_payload(self, payload: str) -> list[ParsedRow]:
        if not payload.strip():
            raise ParsingError("Utility payload is empty.")

        reader = csv.DictReader(io.StringIO(payload))
        if not reader.fieldnames:
            raise ParsingError("Utility payload has no header row.")

        parsed_rows: list[ParsedRow] = []
        for row in reader:
            try:
                meter_id = self._extract_meter_id(row)
                raw_quantity = self._parse_decimal(row.get("consumption") or row.get("Consumption"))
                raw_unit = (row.get("unit") or row.get("Unit") or "kWh").strip()
                normalized_quantity = self._convert_to_kwh(raw_quantity, raw_unit)

                billing_start, billing_end = self._extract_billing_period(row)
                calculated_co2e_kg = normalized_quantity * self.ELECTRICITY_GRID_FACTOR_KG_PER_KWH

                parsed_rows.append(
                    ParsedRow(
                        raw_payload=dict(row),
                        activity_type=f"electricity:{meter_id}",
                        raw_quantity=raw_quantity,
                        raw_unit=raw_unit,
                        normalized_quantity=normalized_quantity,
                        normalized_unit="kWh",
                        emissions_factor=self.ELECTRICITY_GRID_FACTOR_KG_PER_KWH,
                        calculated_co2e_kg=calculated_co2e_kg,
                        billing_start_date=billing_start,
                        billing_end_date=billing_end,
                        scope_category=ScopeCategory.SCOPE_2,
                        metadata={"meter_id": meter_id},
                        validation_errors=[],
                    )
                )
            except (ParsingError, ValidationError, KeyError, TypeError, ValueError) as exc:
                parsed_rows.append(
                    self._build_failed_row(
                        raw_payload=dict(row),
                        error_message=f"Utility parsing failure: {exc}",
                        activity_type="electricity:unknown",
                        scope_category=ScopeCategory.SCOPE_2,
                    )
                )
        return parsed_rows

    def _extract_meter_id(self, row: dict[str, str]) -> str:
        meter_id = (row.get("meter_id") or row.get("MeterID") or row.get("UtilityMeter") or "").strip()
        if not meter_id:
            meter_id = "UNKNOWN_METER"
        return meter_id

    def _extract_billing_period(self, row: dict[str, str]) -> tuple[date | None, date | None]:
        start_raw = row.get("billing_start") or row.get("BillingStart") or row.get("FromDate")
        end_raw = row.get("billing_end") or row.get("BillingEnd") or row.get("ToDate")
        return self._parse_flexible_date(start_raw), self._parse_flexible_date(end_raw)

    def _convert_to_kwh(self, quantity: Decimal, unit: str) -> Decimal:
        normalized_unit = unit.strip().lower()
        if normalized_unit == "kwh":
            return quantity
        if normalized_unit == "wh":
            return quantity / Decimal("1000")
        if normalized_unit == "mwh":
            return quantity * Decimal("1000")
        raise ParsingError(f"Unsupported electricity unit: {unit}")


class CorporateTravelEngine(BaseIngestionEngine):
    """
    Parser for nested corporate travel API payloads.

    Expected payload shape:
    {
      "trips": [
        {"type": "flight", "origin_iata": "JFK", "destination_iata": "BLR", ...},
        {"type": "hotel", "nights": 3, ...},
        {"type": "ground_transport", "distance_km": 28, ...}
      ]
    }

    Flight distance handling:
    - Uses an internal IATA -> coordinate lookup.
    - Applies Haversine formula to compute geodesic distance in kilometers.
    - Maps all travel modes to Scope 3 with mode-specific emission factors.
    """

    AIRPORT_COORDINATES = {
        "JFK": (40.6413, -73.7781),
        "BLR": (13.1986, 77.7066),
        "CDG": (49.0097, 2.5479),
        "LHR": (51.4700, -0.4543),
        "DXB": (25.2532, 55.3657),
        "FRA": (50.0379, 8.5622),
        "SFO": (37.6213, -122.3790),
    }
    TRAVEL_EMISSION_FACTORS = {
        "flight": Decimal("0.115"),
        "hotel": Decimal("15.000"),
        "ground_transport": Decimal("0.180"),
    }

    def parse_payload(self, payload: str) -> list[ParsedRow]:
        if not payload.strip():
            raise ParsingError("Corporate travel payload is empty.")

        try:
            body = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise ParsingError("Corporate travel payload is not valid JSON.") from exc

        trips = body.get("trips")
        if not isinstance(trips, list):
            raise ParsingError("Corporate travel payload must include a 'trips' list.")

        parsed_rows: list[ParsedRow] = []
        for trip in trips:
            try:
                parsed_rows.append(self._parse_trip(trip))
            except (ParsingError, ValidationError, KeyError, TypeError, ValueError) as exc:
                parsed_rows.append(
                    self._build_failed_row(
                        raw_payload=trip if isinstance(trip, dict) else {"raw_trip": trip},
                        error_message=f"Travel parsing failure: {exc}",
                        activity_type="travel:unknown",
                        scope_category=ScopeCategory.SCOPE_3,
                    )
                )
        return parsed_rows

    def _parse_trip(self, trip: dict[str, Any]) -> ParsedRow:
        travel_type = str(trip.get("type", "")).strip().lower()
        start_date = self._parse_flexible_date(trip.get("start_date"))
        end_date = self._parse_flexible_date(trip.get("end_date"))

        if travel_type == "flight":
            origin = str(trip.get("origin_iata", "")).strip().upper()
            destination = str(trip.get("destination_iata", "")).strip().upper()
            distance_km = self._compute_flight_distance(origin, destination)
            raw_quantity = distance_km
            raw_unit = "km"
            normalized_quantity = distance_km
            normalized_unit = "km"
        elif travel_type == "hotel":
            nights = self._parse_decimal(trip.get("nights"))
            raw_quantity = nights
            raw_unit = "nights"
            normalized_quantity = nights
            normalized_unit = "nights"
        elif travel_type == "ground_transport":
            distance_km = self._parse_decimal(trip.get("distance_km"))
            raw_quantity = distance_km
            raw_unit = "km"
            normalized_quantity = distance_km
            normalized_unit = "km"
        else:
            raise ParsingError(f"Unsupported travel type: {travel_type}")

        emission_factor = self.TRAVEL_EMISSION_FACTORS[travel_type]
        calculated_co2e_kg = normalized_quantity * emission_factor

        return ParsedRow(
            raw_payload=trip,
            activity_type=f"travel:{travel_type}",
            raw_quantity=raw_quantity,
            raw_unit=raw_unit,
            normalized_quantity=normalized_quantity,
            normalized_unit=normalized_unit,
            emissions_factor=emission_factor,
            calculated_co2e_kg=calculated_co2e_kg,
            billing_start_date=start_date,
            billing_end_date=end_date or start_date,
            scope_category=ScopeCategory.SCOPE_3,
            metadata={"travel_type": travel_type},
            validation_errors=[],
        )

    def _compute_flight_distance(self, origin_iata: str, destination_iata: str) -> Decimal:
        origin_coordinates = self.AIRPORT_COORDINATES.get(origin_iata)
        destination_coordinates = self.AIRPORT_COORDINATES.get(destination_iata)
        if not origin_coordinates or not destination_coordinates:
            raise ParsingError(
                f"Missing airport coordinates for route {origin_iata} -> {destination_iata}."
            )
        return self._haversine_km(origin_coordinates, destination_coordinates)

    @staticmethod
    def _haversine_km(
        origin_coordinates: tuple[float, float],
        destination_coordinates: tuple[float, float],
    ) -> Decimal:
        earth_radius_km = 6371.0
        origin_lat, origin_lon = origin_coordinates
        destination_lat, destination_lon = destination_coordinates

        delta_lat = math.radians(destination_lat - origin_lat)
        delta_lon = math.radians(destination_lon - origin_lon)

        lat1 = math.radians(origin_lat)
        lat2 = math.radians(destination_lat)

        haversine_value = (
            math.sin(delta_lat / 2) ** 2
            + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
        )
        arc = 2 * math.atan2(math.sqrt(haversine_value), math.sqrt(1 - haversine_value))
        return Decimal(str(earth_radius_km * arc)).quantize(Decimal("0.000001"))


def process_sap_payload(
    organization: Organization,
    batch: IngestionBatch,
    payload: str,
) -> list[NormalizedEmissionRecord]:
    """Convenience entrypoint to process SAP payloads."""

    engine = SAPIngestionEngine(organization=organization, batch=batch)
    return engine.process(payload)


def process_utility_payload(
    organization: Organization,
    batch: IngestionBatch,
    payload: str,
) -> list[NormalizedEmissionRecord]:
    """Convenience entrypoint to process utility portal payloads."""

    engine = UtilityPortalEngine(organization=organization, batch=batch)
    return engine.process(payload)


def process_travel_payload(
    organization: Organization,
    batch: IngestionBatch,
    payload: str,
) -> list[NormalizedEmissionRecord]:
    """Convenience entrypoint to process corporate travel payloads."""

    engine = CorporateTravelEngine(organization=organization, batch=batch)
    return engine.process(payload)
