"""URL routes for emissions tracker DRF endpoints."""

from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import (
    AuditTrailViewSet,
    DataIngestionViewSet,
    IngestionBatchViewSet,
    NormalizedEmissionRecordViewSet,
    OrganizationViewSet,
    RawDataRecordViewSet,
)

router = DefaultRouter()
router.register(r"ingest", DataIngestionViewSet, basename="ingest")
router.register(r"organizations", OrganizationViewSet, basename="organization")
router.register(r"batches", IngestionBatchViewSet, basename="batch")
router.register(r"records", NormalizedEmissionRecordViewSet, basename="record")
router.register(r"raw-records", RawDataRecordViewSet, basename="raw-record")
router.register(r"audit-trails", AuditTrailViewSet, basename="audit-trail")

urlpatterns = [
    path("api/", include(router.urls)),
]
