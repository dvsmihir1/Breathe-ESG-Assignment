/**
 * API and mock integration layer for emissions workspace dashboards.
 *
 * Design goals:
 * - Mirror backend DRF endpoints for batches and records.
 * - Enforce organization-scoped requests for multi-tenant safety.
 * - Provide deterministic, realistic mock data when backend is unavailable.
 * - Keep mock structures aligned with backend serializers for seamless swapping.
 */

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || "http://localhost:8000";
const DEFAULT_OPERATOR_ID = "analyst@breatheesg.com";

function buildMockEnterpriseDataSet() {
  const organizations = [
    { id: 1, name: "Breathe ESG - Europe Division" },
    { id: 2, name: "Breathe ESG - APAC Division" },
    { id: 3, name: "Breathe ESG - Global Holding" },
  ];

  const batches = [
    {
      id: 101,
      organization: 1,
      source_type: "SAP",
      status: "PENDING_REVIEW",
      file_name: "SAP_DE_Q1_ENERGY_INGEST.csv",
      ingested_at: "2026-05-20T08:42:00Z",
      total_records: 12,
      successful_entries: 9,
      suspicious_flags: 2,
    },
    {
      id: 102,
      organization: 1,
      source_type: "UTILITY",
      status: "SUSPICIOUS",
      file_name: "UtilityPortal_Nov12_Dec14_MeterExport.csv",
      ingested_at: "2026-05-22T14:16:00Z",
      total_records: 8,
      successful_entries: 5,
      suspicious_flags: 2,
    },
    {
      id: 103,
      organization: 1,
      source_type: "TRAVEL",
      status: "VALIDATION_FAILED",
      file_name: "Concur_TravelFeed_April.json",
      ingested_at: "2026-05-24T11:25:00Z",
      total_records: 7,
      successful_entries: 4,
      suspicious_flags: 1,
    },
    {
      id: 201,
      organization: 2,
      source_type: "SAP",
      status: "PENDING_REVIEW",
      file_name: "SAP_APAC_PROCUREMENT.csv",
      ingested_at: "2026-05-18T06:30:00Z",
      total_records: 10,
      successful_entries: 8,
      suspicious_flags: 1,
    },
  ];

  const records = [
    {
      id: 5001,
      raw_record: {
        id: 9001,
        batch: 101,
        organization: 1,
        raw_payload: {
          Werk: "P100A",
          Menge: "1.234,56",
          ME: "L",
          Buchungsdatum: "14.05.2026",
          ActivityType: "diesel",
        },
        status: "PENDING_REVIEW",
        validation_errors: [],
      },
      organization: 1,
      scope_category: "SCOPE_1",
      activity_type: "sap:diesel:Berlin Manufacturing Plant",
      raw_quantity: "1234.560000",
      raw_unit: "L",
      normalized_quantity: "1234.560000",
      normalized_unit: "L",
      emissions_factor: "2.6800000000",
      calculated_co2e_kg: "3308.620800",
      billing_start_date: "2026-05-14",
      billing_end_date: "2026-05-14",
      verification_status: "PENDING_REVIEW",
      approved_by: null,
      approved_at: null,
    },
    {
      id: 5002,
      raw_record: {
        id: 9002,
        batch: 101,
        organization: 1,
        raw_payload: {
          Werk: "DE-LEG-01",
          Menge: "800,00",
          ME: "EUR",
          Buchungsdatum: "2026/05/13",
          Kategorie: "procurement",
        },
        status: "SUSPICIOUS",
        validation_errors: ["Consumption > 200% of historical mean."],
      },
      organization: 1,
      scope_category: "SCOPE_3",
      activity_type: "sap:procurement:Frankfurt Procurement Center",
      raw_quantity: "800.000000",
      raw_unit: "EUR",
      normalized_quantity: "800.000000",
      normalized_unit: "EUR_EQ",
      emissions_factor: "0.5000000000",
      calculated_co2e_kg: "400.000000",
      billing_start_date: "2026-05-13",
      billing_end_date: "2026-05-13",
      verification_status: "SUSPICIOUS",
      approved_by: null,
      approved_at: null,
    },
    {
      id: 5003,
      raw_record: {
        id: 9010,
        batch: 102,
        organization: 1,
        raw_payload: {
          MeterID: "MTR-DE-BER-7781",
          Consumption: "4200",
          Unit: "kWh",
          BillingStart: "12/11/2025",
          BillingEnd: "14/12/2025",
        },
        status: "PENDING_REVIEW",
        validation_errors: [],
      },
      organization: 1,
      scope_category: "SCOPE_2",
      activity_type: "electricity:MTR-DE-BER-7781",
      raw_quantity: "4200.000000",
      raw_unit: "kWh",
      normalized_quantity: "4200.000000",
      normalized_unit: "kWh",
      emissions_factor: "0.4750000000",
      calculated_co2e_kg: "1995.000000",
      billing_start_date: "2025-11-12",
      billing_end_date: "2025-12-14",
      verification_status: "PENDING_REVIEW",
      approved_by: null,
      approved_at: null,
    },
    {
      id: 5004,
      raw_record: {
        id: 9011,
        batch: 102,
        organization: 1,
        raw_payload: {
          meter_id: "MTR-DE-BER-7781",
          consumption: "9800",
          unit: "kWh",
          billing_start: "2025-12-10",
          billing_end: "2026-01-12",
        },
        status: "SUSPICIOUS",
        validation_errors: ["Overlapping billing windows detected for the same meter."],
      },
      organization: 1,
      scope_category: "SCOPE_2",
      activity_type: "electricity:MTR-DE-BER-7781",
      raw_quantity: "9800.000000",
      raw_unit: "kWh",
      normalized_quantity: "9800.000000",
      normalized_unit: "kWh",
      emissions_factor: "0.4750000000",
      calculated_co2e_kg: "4655.000000",
      billing_start_date: "2025-12-10",
      billing_end_date: "2026-01-12",
      verification_status: "SUSPICIOUS",
      approved_by: null,
      approved_at: null,
    },
    {
      id: 5005,
      raw_record: {
        id: 9020,
        batch: 103,
        organization: 1,
        raw_payload: {
          trip: {
            type: "flight",
            origin_iata: "JFK",
            destination_iata: "BLR",
            traveler_count: 1,
          },
          hotel: {
            nights: 3,
            city_code: "BLR",
          },
        },
        status: "PENDING_REVIEW",
        validation_errors: [],
      },
      organization: 1,
      scope_category: "SCOPE_3",
      activity_type: "travel:flight",
      raw_quantity: "13363.251000",
      raw_unit: "km",
      normalized_quantity: "13363.251000",
      normalized_unit: "km",
      emissions_factor: "0.1150000000",
      calculated_co2e_kg: "1536.773865",
      billing_start_date: "2026-04-02",
      billing_end_date: "2026-04-03",
      verification_status: "PENDING_REVIEW",
      approved_by: null,
      approved_at: null,
    },
    {
      id: 5006,
      raw_record: {
        id: 9021,
        batch: 103,
        organization: 1,
        raw_payload: {
          type: "ground_transport",
          distance_km: "-28",
          start_date: "April-35-2026",
          end_date: "April-35-2026",
        },
        status: "VALIDATION_FAILED",
        validation_errors: [
          "Negative quantity values are not allowed.",
          "Billing dates are unparseable or missing.",
        ],
      },
      organization: 1,
      scope_category: "SCOPE_3",
      activity_type: "travel:ground_transport",
      raw_quantity: "0.000000",
      raw_unit: "UNKNOWN",
      normalized_quantity: "0.000000",
      normalized_unit: "UNKNOWN",
      emissions_factor: "0.0000000000",
      calculated_co2e_kg: "0.000000",
      billing_start_date: "2026-04-10",
      billing_end_date: "2026-04-10",
      verification_status: "VALIDATION_FAILED",
      approved_by: null,
      approved_at: null,
    },
  ];

  return { organizations, batches, records };
}

const MOCK_DATA_SET = buildMockEnterpriseDataSet();

const SOURCE_COLORS = {
  SAP: "bg-blue-500/20 text-blue-200 border border-blue-500/40",
  UTILITY: "bg-purple-500/20 text-purple-200 border border-purple-500/40",
  TRAVEL: "bg-teal-500/20 text-teal-200 border border-teal-500/40",
};

function buildQueryString(params = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      searchParams.append(key, String(value));
    }
  });
  return searchParams.toString();
}

async function httpGet(path, queryParams = {}, headers = {}) {
  const queryString = buildQueryString(queryParams);
  const endpoint = `${API_BASE_URL}${path}${queryString ? `?${queryString}` : ""}`;
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${endpoint}`);
  }
  return response.json();
}

async function httpPost(path, body = null, headers = {}) {
  const endpoint = `${API_BASE_URL}${path}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : null,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${endpoint}`);
  }
  return response.json();
}

function normalizeApiListResponse(jsonPayload) {
  if (Array.isArray(jsonPayload)) {
    return jsonPayload;
  }
  if (jsonPayload && Array.isArray(jsonPayload.results)) {
    return jsonPayload.results;
  }
  return [];
}

function getMockBatches(orgId) {
  return MOCK_DATA_SET.batches.filter((batch) => batch.organization === Number(orgId));
}

function getMockRecords({ orgId, batchId, status }) {
  return MOCK_DATA_SET.records.filter((record) => {
    const isOrgMatch = record.organization === Number(orgId);
    const isBatchMatch = batchId ? Number(record.raw_record.batch) === Number(batchId) : true;
    const isStatusMatch = status ? record.verification_status === status : true;
    return isOrgMatch && isBatchMatch && isStatusMatch;
  });
}

export async function getOrganizations() {
  try {
    const jsonResponse = await httpGet("/api/organizations/");
    return normalizeApiListResponse(jsonResponse);
  } catch (error) {
    return MOCK_DATA_SET.organizations;
  }
}

export async function getBatches(orgId) {
  const query = { org_id: orgId };
  const headers = { "X-Organization-Id": String(orgId) };
  try {
    const jsonResponse = await httpGet("/api/batches/", query, headers);
    const normalized = normalizeApiListResponse(jsonResponse);
    if (normalized.length > 0) {
      return normalized.map((batch) => ({
        ...batch,
        source_type_badge_class: SOURCE_COLORS[batch.source_type] || "bg-zinc-800 text-zinc-200 border border-zinc-700",
      }));
    }
    throw new Error("Backend returned empty dataset.");
  } catch (error) {
    return getMockBatches(orgId).map((batch) => ({
      ...batch,
      source_type_badge_class: SOURCE_COLORS[batch.source_type] || "bg-zinc-800 text-zinc-200 border border-zinc-700",
    }));
  }
}

export async function getRecords({ orgId, batchId, status }) {
  const query = { org_id: orgId, batch_id: batchId, status };
  const headers = { "X-Organization-Id": String(orgId) };
  try {
    const jsonResponse = await httpGet("/api/records/", query, headers);
    const normalized = normalizeApiListResponse(jsonResponse);
    if (normalized.length > 0) {
      return normalized;
    }
    throw new Error("Backend returned empty dataset.");
  } catch (error) {
    return getMockRecords({ orgId, batchId, status });
  }
}

export async function approveRecord(recordId) {
  try {
    return await httpPost(`/api/records/${recordId}/approve/`);
  } catch (error) {
    const record = MOCK_DATA_SET.records.find((entry) => Number(entry.id) === Number(recordId));
    if (!record) {
      throw new Error(`Failed to approve record ${recordId}`);
    }
    record.verification_status = "APPROVED_LOCKED";
    record.approved_at = new Date().toISOString();
    record.approved_by = DEFAULT_OPERATOR_ID;
    if (record.raw_record) {
      record.raw_record.status = "APPROVED_LOCKED";
    }
    return { ...record };
  }
}

export async function flagRecord(recordId, validationErrors) {
  try {
    return await httpPost(`/api/records/${recordId}/flag/`, {
      validation_errors: validationErrors,
    });
  } catch (error) {
    const record = MOCK_DATA_SET.records.find((entry) => Number(entry.id) === Number(recordId));
    if (!record) {
      throw new Error(`Failed to flag record ${recordId}`);
    }
    const parsedErrors = Array.isArray(validationErrors) ? validationErrors : [validationErrors];
    record.verification_status = "SUSPICIOUS";
    if (record.raw_record) {
      const existingErrors = Array.isArray(record.raw_record.validation_errors)
        ? record.raw_record.validation_errors
        : [];
      record.raw_record.status = "SUSPICIOUS";
      record.raw_record.validation_errors = [...existingErrors, ...parsedErrors];
    }
    return { ...record };
  }
}

