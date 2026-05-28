"""Serializers for tenant-scoped emissions ingestion and analytics workflows."""

from __future__ import annotations

from rest_framework import serializers

from .models import (
    AuditTrail,
    IngestionBatch,
    NormalizedEmissionRecord,
    Organization,
    RawDataRecord,
)


class OrganizationSerializer(serializers.ModelSerializer):
    """Full serializer for tenant organizations."""

    class Meta:
        model = Organization
        fields = "__all__"


class IngestionBatchSerializer(serializers.ModelSerializer):
    """Serializer for ingestion batch metadata and processing rollups."""

    total_records = serializers.SerializerMethodField()
    successful_entries = serializers.SerializerMethodField()
    suspicious_flags = serializers.SerializerMethodField()

    class Meta:
        model = IngestionBatch
        fields = [
            "id",
            "organization",
            "source_type",
            "status",
            "file_name",
            "ingested_at",
            "total_records",
            "successful_entries",
            "suspicious_flags",
        ]

    def get_total_records(self, obj: IngestionBatch) -> int:
        return obj.raw_data_records.count()

    def get_successful_entries(self, obj: IngestionBatch) -> int:
        return NormalizedEmissionRecord.objects.filter(
            raw_record__batch=obj,
            verification_status__in=["PENDING_REVIEW", "APPROVED_LOCKED"]
        ).count()

    def get_suspicious_flags(self, obj: IngestionBatch) -> int:
        return NormalizedEmissionRecord.objects.filter(
            raw_record__batch=obj,
            verification_status="SUSPICIOUS",
        ).count()


class RawDataRecordSerializer(serializers.ModelSerializer):
    """
    Serializer for immutable raw source records.

    Exposes original raw payload and validation errors for analyst review.
    """

    class Meta:
        model = RawDataRecord
        fields = [
            "id",
            "batch",
            "organization",
            "raw_payload",
            "status",
            "validation_errors",
        ]
        read_only_fields = ["id"]


class NormalizedEmissionRecordSerializer(serializers.ModelSerializer):
    """
    Serializer for normalized emissions records with side-by-side raw evidence.

    Includes nested raw record content to support analyst reconciliation of
    transformed metrics against source data.
    """

    raw_record = RawDataRecordSerializer(read_only=True)
    raw_record_id = serializers.PrimaryKeyRelatedField(
        source="raw_record",
        queryset=RawDataRecord.objects.all(),
        write_only=True,
        required=False,
    )

    class Meta:
        model = NormalizedEmissionRecord
        fields = [
            "id",
            "raw_record",
            "raw_record_id",
            "organization",
            "scope_category",
            "activity_type",
            "raw_quantity",
            "raw_unit",
            "normalized_quantity",
            "normalized_unit",
            "emissions_factor",
            "calculated_co2e_kg",
            "billing_start_date",
            "billing_end_date",
            "verification_status",
            "approved_by",
            "approved_at",
        ]
        read_only_fields = ["id", "approved_at"]


class AuditTrailSerializer(serializers.ModelSerializer):
    """Serializer for immutable audit event records."""

    class Meta:
        model = AuditTrail
        fields = [
            "id",
            "organization",
            "record_id",
            "action_taken",
            "executed_by",
            "timestamp",
            "changes_json",
        ]
        read_only_fields = ["id", "timestamp"]
