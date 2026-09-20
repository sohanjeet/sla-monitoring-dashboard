export const EXPECTED_HEADER = [
  'service_id',
  'service_name',
  'timestamp',
  'status_code',
  'latency',
  'latency_unit',
  'agent',
  'region',
] as const

export type MonitoringField = (typeof EXPECTED_HEADER)[number]

export type RawMonitoringRow = Record<MonitoringField, string>

export interface CsvRow {
  /** One-based CSV record number; the header is record 1. */
  recordNumber: number
  values: string[]
}

export type IssueSeverity = 'error' | 'warning'

export interface QualityIssue {
  code: string
  message: string
  severity: IssueSeverity
  field?: MonitoringField
}

export type SlaHealth = 'healthy' | 'unavailable' | 'unmapped'

export type LatencyQuality =
  | 'valid'
  | 'missing_latency'
  | 'invalid_negative_latency'

export interface NormalizedMonitoringRow {
  datasetId: string
  sourceRowNumber: number
  serviceId: string
  serviceName: string
  observedAtUtc: string
  statusCode: number
  slaHealth: SlaHealth
  latencyMs: number | null
  latencyQuality: LatencyQuality
  latencyUnit: 'ms' | 's'
  agent: string
  region: string
  raw: RawMonitoringRow
}

export interface RejectedRow {
  sourceRowNumber: number
  rawRecord: string[]
  issues: QualityIssue[]
}

export interface DuplicateRow {
  sourceRowNumber: number
  duplicateOfRowNumber: number
  rawRecord: RawMonitoringRow
  issues: QualityIssue[]
}

export interface ProcessingResult {
  totalRows: number
  /** Rows retained after validation and exact-duplicate removal. */
  validRows: number
  /** Includes malformed/invalid rows and later exact duplicates. */
  rejectedRows: number
  duplicates: number
  normalizedCounts: {
    timestamps: number
    latencyUnitConversions: number
  }
  cleanedCounts: {
    retainedReports: number
    missingLatency: number
    negativeLatency: number
    unmappedStatusForSla: number
  }
  issueCounts: Record<string, number>
  records: NormalizedMonitoringRow[]
  rejected: RejectedRow[]
  duplicateRows: DuplicateRow[]
}
