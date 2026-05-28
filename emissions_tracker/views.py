"""
DRF view layer for emissions processing and analyst workflows.

Operational state-machine workflow:
- Ingestion engines emit per-row statuses in the set:
  RAW, PENDING_REVIEW, SUSPICIOUS, VALIDATION_FAILED, APPROVED_LOCKED.
- Analyst actions can promote a record to APPROVED_LOCKED via /approve/ or set
  SUSPICIOUS via /flag/. Once APPROVED_LOCKED, model-level immutability rules
  prevent subsequent modification or deletion.

Multi-tenant scoping mechanism:
- Record and batch queries require an explicit organization selector supplied as
  query param (?org_id=...) or HTTP header (X-Organization-Id).
- All querysets are structurally filtered by organization before object lookup,
  making cross-tenant data access impossible through this API layer.
"""

from __future__ import annotations

from django.db import transaction
from django.utils import timezone
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from .ingestion_engines import (
    IngestionEngineError,
    process_sap_payload,
    process_travel_payload,
    process_utility_payload,
)
from .models import (
    AuditTrail,
    EmissionsWorkflowStatus,
    IngestionBatch,
    NormalizedEmissionRecord,
    Organization,
    RawDataRecord,
    SourceType,
)
from .serializers import (
    AuditTrailSerializer,
    IngestionBatchSerializer,
    NormalizedEmissionRecordSerializer,
    OrganizationSerializer,
    RawDataRecordSerializer,
)


class OrganizationViewSet(viewsets.ReadOnlyModelViewSet):
    """Read-only organization directory endpoint."""

    queryset = Organization.objects.all().order_by("name")
    serializer_class = OrganizationSerializer


class IngestionBatchViewSet(viewsets.ReadOnlyModelViewSet):
    """Tenant-scoped batch listing endpoint."""

    serializer_class = IngestionBatchSerializer

    def _require_org_id(self) -> int:
        org_id = self.request.query_params.get("org_id") or self.request.headers.get("X-Organization-Id")
        if not org_id:
            raise ValidationError(
                {"organization": "Provide organization via ?org_id=<id> or X-Organization-Id header."}
            )
        try:
            return int(org_id)
        except ValueError as exc:
            raise ValidationError({"organization": "Organization id must be an integer."}) from exc

    def get_queryset(self):
        org_id = self._require_org_id()
        queryset = IngestionBatch.objects.filter(organization_id=org_id).select_related("organization")

        source_type = self.request.query_params.get("source_type")
        if source_type:
            queryset = queryset.filter(source_type=source_type)
        return queryset.order_by("-ingested_at")


class RawDataRecordViewSet(viewsets.ReadOnlyModelViewSet):
    """Tenant-scoped raw records endpoint for forensic review."""

    serializer_class = RawDataRecordSerializer

    def _require_org_id(self) -> int:
        org_id = self.request.query_params.get("org_id") or self.request.headers.get("X-Organization-Id")
        if not org_id:
            raise ValidationError(
                {"organization": "Provide organization via ?org_id=<id> or X-Organization-Id header."}
            )
        try:
            return int(org_id)
        except ValueError as exc:
            raise ValidationError({"organization": "Organization id must be an integer."}) from exc

    def get_queryset(self):
        org_id = self._require_org_id()
        queryset = RawDataRecord.objects.filter(organization_id=org_id).select_related("batch", "organization")

        batch_id = self.request.query_params.get("batch_id")
        if batch_id:
            queryset = queryset.filter(batch_id=batch_id)

        status_filter = self.request.query_params.get("status")
        if status_filter:
            queryset = queryset.filter(status=status_filter)

        return queryset.order_by("-id")


class DataIngestionViewSet(viewsets.ViewSet):
    """
    Ingestion endpoint that routes payloads to deterministic parsing engines.

    Request body:
    {
      "organization_id": 1,
      "source_type": "SAP" | "UTILITY" | "TRAVEL",
      "payload": "<raw csv/json string>",
      "file_name": "optional-source-name.csv"
    }
    """

    def create(self, request):
        organization_id = request.data.get("organization_id")
        source_type = request.data.get("source_type")
        payload = request.data.get("payload")
        file_name = request.data.get("file_name") or f"{source_type or 'UNKNOWN'}_upload"

        if not organization_id or not source_type or payload is None:
            return Response(
                {"detail": "organization_id, source_type, and payload are required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if source_type not in SourceType.values:
            return Response(
                {"detail": f"source_type must be one of: {', '.join(SourceType.values)}"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            organization = Organization.objects.get(pk=organization_id)
        except Organization.DoesNotExist:
            return Response(
                {"detail": "Organization does not exist."},
                status=status.HTTP_404_NOT_FOUND,
            )

        batch = IngestionBatch.objects.create(
            organization=organization,
            source_type=source_type,
            status=EmissionsWorkflowStatus.RAW,
            file_name=file_name,
        )

        try:
            with transaction.atomic():
                if source_type == SourceType.SAP:
                    created_records = process_sap_payload(organization=organization, batch=batch, payload=payload)
                elif source_type == SourceType.UTILITY:
                    created_records = process_utility_payload(organization=organization, batch=batch, payload=payload)
                else:
                    created_records = process_travel_payload(organization=organization, batch=batch, payload=payload)
        except IngestionEngineError as exc:
            batch.status = EmissionsWorkflowStatus.VALIDATION_FAILED
            batch.save(update_fields=["status"])
            return Response(
                {
                    "batch_id": batch.id,
                    "organization_id": organization.id,
                    "source_type": source_type,
                    "detail": f"Ingestion engine error: {exc}",
                    "total_records": 0,
                    "successful_entries": 0,
                    "suspicious_entries": 0,
                    "failed_entries": 0,
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        except Exception as exc:
            batch.status = EmissionsWorkflowStatus.VALIDATION_FAILED
            batch.save(update_fields=["status"])
            return Response(
                {
                    "batch_id": batch.id,
                    "organization_id": organization.id,
                    "source_type": source_type,
                    "detail": f"Unhandled ingestion failure: {exc}",
                    "total_records": 0,
                    "successful_entries": 0,
                    "suspicious_entries": 0,
                    "failed_entries": 0,
                },
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        total_records = len(created_records)
        suspicious_entries = sum(
            1 for record in created_records if record.verification_status == EmissionsWorkflowStatus.SUSPICIOUS
        )
        failed_entries = sum(
            1
            for record in created_records
            if record.verification_status == EmissionsWorkflowStatus.VALIDATION_FAILED
        )
        successful_entries = total_records - suspicious_entries - failed_entries

        batch.status = (
            EmissionsWorkflowStatus.VALIDATION_FAILED
            if failed_entries > 0
            else EmissionsWorkflowStatus.PENDING_REVIEW
        )
        batch.save(update_fields=["status"])

        return Response(
            {
                "batch_id": batch.id,
                "organization_id": organization.id,
                "source_type": source_type,
                "batch_status": batch.status,
                "total_records": total_records,
                "successful_entries": successful_entries,
                "suspicious_entries": suspicious_entries,
                "failed_entries": failed_entries,
            },
            status=status.HTTP_201_CREATED,
        )


class NormalizedEmissionRecordViewSet(viewsets.ReadOnlyModelViewSet):
    """Analyst workspace endpoint for tenant-scoped normalized records."""

    serializer_class = NormalizedEmissionRecordSerializer

    def _require_org_id(self) -> int:
        org_id = self.request.query_params.get("org_id") or self.request.headers.get("X-Organization-Id")
        if not org_id:
            raise ValidationError(
                {"organization": "Provide organization via ?org_id=<id> or X-Organization-Id header."}
            )
        try:
            return int(org_id)
        except ValueError as exc:
            raise ValidationError({"organization": "Organization id must be an integer."}) from exc

    def get_queryset(self):
        org_id = self._require_org_id()
        queryset = (
            NormalizedEmissionRecord.objects.filter(organization_id=org_id)
            .select_related("organization", "raw_record", "raw_record__batch")
            .order_by("-billing_end_date", "-id")
        )

        batch_id = self.request.query_params.get("batch_id")
        if batch_id:
            queryset = queryset.filter(raw_record__batch_id=batch_id)

        status_filter = self.request.query_params.get("status")
        if status_filter:
            queryset = queryset.filter(verification_status=status_filter)
        return queryset

    @action(detail=True, methods=["post"], url_path="approve")
    def approve(self, request, pk=None):
        record = self.get_object()
        if record.verification_status == EmissionsWorkflowStatus.APPROVED_LOCKED:
            return Response(
                {"detail": "Record is already APPROVED_LOCKED."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not request.user or not request.user.is_authenticated:
            return Response(
                {"detail": "Authenticated reviewer required to approve a record."},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        previous_status = record.verification_status
        record.verification_status = EmissionsWorkflowStatus.APPROVED_LOCKED
        record.approved_by = request.user
        record.approved_at = timezone.now()
        record.save()

        AuditTrail.objects.create(
            organization=record.organization,
            record_id=str(record.id),
            action_taken="APPROVE_RECORD",
            executed_by=request.user,
            changes_json={
                "from_status": previous_status,
                "to_status": EmissionsWorkflowStatus.APPROVED_LOCKED,
                "approved_at": record.approved_at.isoformat(),
            },
        )

        serializer = self.get_serializer(record)
        return Response(serializer.data, status=status.HTTP_200_OK)

    @action(detail=True, methods=["post"], url_path="flag")
    def flag(self, request, pk=None):
        record = self.get_object()
        if record.verification_status == EmissionsWorkflowStatus.APPROVED_LOCKED:
            return Response(
                {"detail": "Approved locked records cannot be flagged."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not request.user or not request.user.is_authenticated:
            return Response(
                {"detail": "Authenticated analyst required to flag a record."},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        error_override = request.data.get("validation_errors")
        if error_override is None:
            return Response(
                {"detail": "validation_errors is required for manual flagging."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if isinstance(error_override, str):
            override_errors = [error_override]
        elif isinstance(error_override, list) and all(isinstance(item, str) for item in error_override):
            override_errors = error_override
        else:
            return Response(
                {"detail": "validation_errors must be a string or list of strings."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        previous_status = record.verification_status
        record.verification_status = EmissionsWorkflowStatus.SUSPICIOUS
        record.save(update_fields=["verification_status"])

        raw_record = record.raw_record
        raw_record.status = EmissionsWorkflowStatus.SUSPICIOUS
        raw_record.validation_errors = override_errors
        raw_record.save(update_fields=["status", "validation_errors"])

        AuditTrail.objects.create(
            organization=record.organization,
            record_id=str(record.id),
            action_taken="FLAG_RECORD",
            executed_by=request.user,
            changes_json={
                "from_status": previous_status,
                "to_status": EmissionsWorkflowStatus.SUSPICIOUS,
                "validation_errors": override_errors,
            },
        )

        serializer = self.get_serializer(record)
        return Response(serializer.data, status=status.HTTP_200_OK)


class AuditTrailViewSet(viewsets.ReadOnlyModelViewSet):
    """Tenant-scoped audit event endpoint."""

    serializer_class = AuditTrailSerializer

    def _require_org_id(self) -> int:
        org_id = self.request.query_params.get("org_id") or self.request.headers.get("X-Organization-Id")
        if not org_id:
            raise ValidationError(
                {"organization": "Provide organization via ?org_id=<id> or X-Organization-Id header."}
            )
        try:
            return int(org_id)
        except ValueError as exc:
            raise ValidationError({"organization": "Organization id must be an integer."}) from exc

    def get_queryset(self):
        org_id = self._require_org_id()
        return (
            AuditTrail.objects.filter(organization_id=org_id)
            .select_related("organization", "executed_by")
            .order_by("-timestamp")
        )
