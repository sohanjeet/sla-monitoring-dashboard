import { parseCsv } from './parser.js'
import { validateHeader, validateRow } from './validator.js'
import {
  EXPECTED_HEADER,
  type DuplicateRow,
  type NormalizedMonitoringRow,
  type ProcessingResult,
  type QualityIssue,
  type RawMonitoringRow,
  type RejectedRow,
} from './types.js'

function toRawRow(values: string[]): RawMonitoringRow {
  return Object.fromEntries(EXPECTED_HEADER.map((field, index) => [field, values[index] ?? ''])) as RawMonitoringRow
}

function countIssues(target: Record<string, number>, issues: readonly QualityIssue[]): void {
  for (const issue of issues) target[issue.code] = (target[issue.code] ?? 0) + 1
}

/** The source-defined exact-duplicate key, after timestamp normalization. */
function fingerprint(record: NormalizedMonitoringRow): string {
  return JSON.stringify([
    record.datasetId,
    record.serviceId,
    record.observedAtUtc,
    record.statusCode,
    record.raw.latency,
    record.latencyUnit,
    record.agent,
    record.region,
  ])
}

export interface DeduplicationResult {
  records: NormalizedMonitoringRow[]
  duplicates: DuplicateRow[]
}

/** Keeps the earliest physical row and records every later exact duplicate. */
export function deduplicateRows(records: readonly NormalizedMonitoringRow[]): DeduplicationResult {
  const firstRowByFingerprint = new Map<string, NormalizedMonitoringRow>()
  const unique: NormalizedMonitoringRow[] = []
  const duplicates: DuplicateRow[] = []

  for (const record of records) {
    const duplicateOf = firstRowByFingerprint.get(fingerprint(record))
    if (!duplicateOf) {
      firstRowByFingerprint.set(fingerprint(record), record)
      unique.push(record)
      continue
    }
    duplicates.push({
      sourceRowNumber: record.sourceRowNumber,
      duplicateOfRowNumber: duplicateOf.sourceRowNumber,
      rawRecord: record.raw,
      issues: [{
        code: 'duplicate_exact',
        message: `Exact duplicate of source row ${duplicateOf.sourceRowNumber}.`,
        severity: 'error',
      }],
    })
  }
  return { records: unique, duplicates }
}

/**
 * Parses, validates, normalizes and exact-deduplicates a single uploaded CSV.
 * It deliberately does not collapse different reports in the same logical slot;
 * that decision belongs to later conflict-aware SLA aggregation.
 */
export function processCsv(input: string, datasetId: string): ProcessingResult {
  const parsed = parseCsv(input)
  const dataRows = parsed.rows.slice(1)
  const issueCounts: Record<string, number> = {}
  const rejected: RejectedRow[] = []
  const candidates: NormalizedMonitoringRow[] = []
  let timestampNormalizations = 0
  let latencyConversions = 0
  let missingLatency = 0
  let negativeLatency = 0
  let unmappedStatusForSla = 0

  const headerIssues = validateHeader(parsed.rows[0]?.values ?? [])
  if (headerIssues.length > 0) {
    for (const row of dataRows) {
      const rowIssues = [...headerIssues, ...(parsed.issues.get(row.recordNumber) ?? [])]
      rejected.push({ sourceRowNumber: row.recordNumber, rawRecord: row.values, issues: rowIssues })
      countIssues(issueCounts, rowIssues)
    }
    return {
      totalRows: dataRows.length,
      validRows: 0,
      rejectedRows: rejected.length,
      duplicates: 0,
      normalizedCounts: { timestamps: 0, latencyUnitConversions: 0 },
      cleanedCounts: { retainedReports: 0, missingLatency: 0, negativeLatency: 0, unmappedStatusForSla: 0 },
      issueCounts,
      records: [],
      rejected,
      duplicateRows: [],
    }
  }

  for (const row of dataRows) {
    const parseIssues = parsed.issues.get(row.recordNumber) ?? []
    if (parseIssues.length > 0 || row.values.length !== EXPECTED_HEADER.length) {
      const rowIssues = [...parseIssues]
      if (row.values.length !== EXPECTED_HEADER.length) {
        rowIssues.push({
          code: 'invalid_row_shape',
          message: `CSV row must contain exactly ${EXPECTED_HEADER.length} fields.`,
          severity: 'error',
        })
      }
      rejected.push({ sourceRowNumber: row.recordNumber, rawRecord: row.values, issues: rowIssues })
      countIssues(issueCounts, rowIssues)
      continue
    }

    const validation = validateRow(toRawRow(row.values), datasetId, row.recordNumber)
    countIssues(issueCounts, validation.issues)
    if (!validation.valid || !validation.record) {
      rejected.push({ sourceRowNumber: row.recordNumber, rawRecord: row.values, issues: validation.issues })
      continue
    }

    candidates.push(validation.record)
    if (validation.timestampNormalized) timestampNormalizations += 1
    if (validation.latencyConverted) latencyConversions += 1
    if (validation.record.latencyQuality === 'missing_latency') missingLatency += 1
    if (validation.record.latencyQuality === 'invalid_negative_latency') negativeLatency += 1
    if (validation.record.slaHealth === 'unmapped') unmappedStatusForSla += 1
  }

  const deduplicated = deduplicateRows(candidates)
  for (const duplicate of deduplicated.duplicates) {
    rejected.push({
      sourceRowNumber: duplicate.sourceRowNumber,
      rawRecord: EXPECTED_HEADER.map((field) => duplicate.rawRecord[field]),
      issues: duplicate.issues,
    })
    countIssues(issueCounts, duplicate.issues)
  }

  return {
    totalRows: dataRows.length,
    validRows: deduplicated.records.length,
    rejectedRows: rejected.length,
    duplicates: deduplicated.duplicates.length,
    normalizedCounts: { timestamps: timestampNormalizations, latencyUnitConversions: latencyConversions },
    cleanedCounts: {
      retainedReports: deduplicated.records.length,
      missingLatency,
      negativeLatency,
      unmappedStatusForSla,
    },
    issueCounts,
    records: deduplicated.records,
    rejected,
    duplicateRows: deduplicated.duplicates,
  }
}

/** Backwards-compatible name for the processing layer's cleaning entry point. */
export const cleanRecords = processCsv
