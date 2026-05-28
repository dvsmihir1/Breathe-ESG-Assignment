"""
Domain models for multi-tenant emissions ingestion and normalization.

These models are intentionally designed for audit-readiness:
- Every non-Organization record is tenant scoped via a required organization key.
- Raw source payloads are stored separately from normalized calculations.
- Approval lock rules prevent accidental mutation of finalized emissions records.
"""

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.utils import timezone


class EmissionsWorkflowStatus(models.TextChoices):
    """Canonical workflow states used by records that require validation and review."""

    RAW = "RAW", "Raw"
    PENDING_REVIEW = "PENDING_REVIEW", "Pending Review"
    SUSPICIOUS = "SUSPICIOUS", "Suspicious"
    VALIDATION_FAILED = "VALIDATION_FAILED", "Validation Failed"
    APPROVED_LOCKED = "APPROVED_LOCKED", "Approved Locked"


class Organization(models.Model):
    """
    Tenant root for the Breathe ESG platform.

    This is the only globally scoped model. All operational records reference an
    organization to ensure strict data isolation across tenants and audit-safe
    traceability of every ingestion and emissions artifact.
    """

    name = models.CharField(max_length=255)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name


class SourceType(models.TextChoices):
    """Supported ingestion channels."""

    SAP = "SAP", "SAP"
    UTILITY = "UTILITY", "Utility"
    TRAVEL = "TRAVEL", "Travel"


class IngestionBatch(models.Model):
    """
    Tracks a tenant-specific ingestion event and its source metadata.

    A batch is the immutable container for files or payload streams imported from
    upstream systems. Tenant scoping is mandatory to prevent cross-organization
    access when querying ingestion histories.
    """

    organization = models.ForeignKey(
        Organization,
        on_delete=models.PROTECT,
        related_name="ingestion_batches",
    )
    source_type = models.CharField(max_length=20, choices=SourceType.choices)
    status = models.CharField(
        max_length=32,
        choices=EmissionsWorkflowStatus.choices,
        default=EmissionsWorkflowStatus.RAW,
    )
    file_name = models.CharField(max_length=500)
    ingested_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-ingested_at"]
        indexes = [
            models.Index(fields=["organization", "ingested_at"]),
            models.Index(fields=["organization", "status"]),
        ]

    def __str__(self) -> str:
        return f"{self.organization.name} - {self.source_type} - {self.file_name}"


class RawDataRecord(models.Model):
    """
    Immutable capture of source-system payload data for a tenant.

    This model intentionally stores unprocessed JSON payloads and validation
    diagnostics. The separation from normalized records preserves forensic
    traceability and allows reprocessing without mutating original evidence.
    """

    batch = models.ForeignKey(
        IngestionBatch,
        on_delete=models.PROTECT,
        related_name="raw_data_records",
    )
    organization = models.ForeignKey(
        Organization,
        on_delete=models.PROTECT,
        related_name="raw_data_records",
    )
    raw_payload = models.JSONField()
    status = models.CharField(
        max_length=32,
        choices=EmissionsWorkflowStatus.choices,
        default=EmissionsWorkflowStatus.RAW,
    )
    validation_errors = models.JSONField(default=list, blank=True)

    class Meta:
        ordering = ["id"]
        indexes = [
            models.Index(fields=["organization", "status"]),
            models.Index(fields=["batch", "organization"]),
        ]

    def clean(self) -> None:
        if self.batch_id and self.organization_id and self.batch.organization_id != self.organization_id:
            raise ValidationError(
                {"organization": "Raw data record organization must match the batch organization."}
            )

    def save(self, *args, **kwargs):
        self.full_clean()
        super().save(*args, **kwargs)

    def __str__(self) -> str:
        return f"RawDataRecord {self.pk} ({self.organization.name})"


class ScopeCategory(models.TextChoices):
    """Greenhouse gas protocol scope categorization."""

    SCOPE_1 = "SCOPE_1", "Scope 1"
    SCOPE_2 = "SCOPE_2", "Scope 2"
    SCOPE_3 = "SCOPE_3", "Scope 3"


class NormalizedEmissionRecord(models.Model):
    """
    Calculated and normalized emissions artifact derived from raw payload evidence.

    This model stores converted quantities, factors, and calculated CO2e values in
    a tenant-scoped, reviewable structure. Once the verification status reaches
    APPROVED_LOCKED, the record becomes immutable to support audit-grade controls.
    """

    raw_record = models.ForeignKey(
        RawDataRecord,
        on_delete=models.PROTECT,
        related_name="normalized_emission_records",
    )
    organization = models.ForeignKey(
        Organization,
        on_delete=models.PROTECT,
        related_name="normalized_emission_records",
    )
    scope_category = models.CharField(max_length=20, choices=ScopeCategory.choices)
    activity_type = models.CharField(max_length=255)
    raw_quantity = models.DecimalField(max_digits=20, decimal_places=6)
    raw_unit = models.CharField(max_length=50)
    normalized_quantity = models.DecimalField(max_digits=20, decimal_places=6)
    normalized_unit = models.CharField(max_length=50)
    emissions_factor = models.DecimalField(max_digits=20, decimal_places=10)
    calculated_co2e_kg = models.DecimalField(max_digits=20, decimal_places=6)
    billing_start_date = models.DateField()
    billing_end_date = models.DateField()
    verification_status = models.CharField(
        max_length=32,
        choices=EmissionsWorkflowStatus.choices,
        default=EmissionsWorkflowStatus.PENDING_REVIEW,
    )
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="approved_emissions_records",
    )
    approved_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-billing_end_date", "-id"]
        indexes = [
            models.Index(fields=["organization", "verification_status"]),
            models.Index(fields=["organization", "scope_category"]),
            models.Index(fields=["raw_record", "organization"]),
        ]

    def clean(self) -> None:
        if (
            self.raw_record_id
            and self.organization_id
            and self.raw_record.organization_id != self.organization_id
        ):
            raise ValidationError(
                {"organization": "Normalized record organization must match the raw record organization."}
            )

        if self.billing_end_date and self.billing_start_date:
            if self.billing_end_date < self.billing_start_date:
                raise ValidationError(
                    {"billing_end_date": "Billing end date cannot be earlier than billing start date."}
                )

        if self.verification_status == EmissionsWorkflowStatus.APPROVED_LOCKED and not self.approved_at:
            self.approved_at = timezone.now()

    def save(self, *args, **kwargs):
        if self.pk:
            existing_record = type(self).objects.filter(pk=self.pk).only("verification_status").first()
            if (
                existing_record
                and existing_record.verification_status == EmissionsWorkflowStatus.APPROVED_LOCKED
            ):
                raise ValidationError("Approved locked emission records are immutable and cannot be updated.")
        self.full_clean()
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if self.verification_status == EmissionsWorkflowStatus.APPROVED_LOCKED:
            raise ValidationError("Approved locked emission records are immutable and cannot be deleted.")
        return super().delete(*args, **kwargs)

    def __str__(self) -> str:
        return f"NormalizedEmissionRecord {self.pk} ({self.organization.name})"


class AuditTrail(models.Model):
    """
    Audit log stream for tenant-specific actions and change snapshots.

    Keeps a durable record of operational events for internal controls,
    regulator-facing evidence, and incident reconstruction. The organization key
    is mandatory to preserve strict tenant-level observability boundaries.
    """

    organization = models.ForeignKey(
        Organization,
        on_delete=models.PROTECT,
        related_name="audit_trails",
    )
    record_id = models.CharField(max_length=255)
    action_taken = models.CharField(max_length=255)
    executed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="emissions_audit_events",
    )
    timestamp = models.DateTimeField(auto_now_add=True)
    changes_json = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["-timestamp"]
        indexes = [
            models.Index(fields=["organization", "timestamp"]),
            models.Index(fields=["organization", "record_id"]),
        ]

    def __str__(self) -> str:
        return f"AuditTrail {self.record_id} ({self.organization.name})"
