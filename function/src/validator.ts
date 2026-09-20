import {
  EXPECTED_HEADER,
  type LatencyQuality,
  type NormalizedMonitoringRow,
  type QualityIssue,
  type RawMonitoringRow,
  type SlaHealth,
} from './types.js'

const SERVICE_NAMES: Record<string, string> = {
  'svc-auth': 'auth-api',
  'svc-notify': 'notify-worker',
  'svc-payments': 'payments-api',
  'svc-reports': 'reports-api',
  'svc-search': 'search-api',
}

const RFC3339_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/
const EPOCH_SECONDS = /^\d{10}$/
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/

export interface ParseTimestampResult {
  utc?: string
  date?: Date
  issue?: QualityIssue
}

export interface StatusCodeResult {
  statusCode?: number
  slaHealth?: SlaHealth
  issue?: QualityIssue
}

export interface LatencyResult {
  latencyMs: number | null
  quality?: LatencyQuality
  issue?: QualityIssue
  convertedFromSeconds: boolean
}

export interface RowValidationResult {
  valid: boolean
  record?: NormalizedMonitoringRow
  issues: QualityIssue[]
  timestampNormalized: boolean
  latencyConverted: boolean
}

function error(code: string, message: string, field?: keyof RawMonitoringRow): QualityIssue {
  return { code, message, severity: 'error', field }
}

function warning(code: string, message: string, field?: keyof RawMonitoringRow): QualityIssue {
  return { code, message, severity: 'warning', field }
}

/** Parses only the three timestamp encodings discovered in the supplied data. */
export function parseTimestamp(rawValue: string): ParseTimestampResult {
  const value = rawValue.trim()
  let milliseconds: number

  if (EPOCH_SECONDS.test(value)) {
    milliseconds = Number(value) * 1_000
  } else {
    const match = RFC3339_INSTANT.exec(value)
    if (!match) {
      return {
        issue: error(
          'invalid_timestamp_format',
          'Timestamp must be RFC 3339 with Z/an explicit offset, or a ten-digit Unix-seconds value.',
          'timestamp',
        ),
      }
    }

    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
    const utcCivilTime = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
    const validCivilTime = utcCivilTime.getUTCFullYear() === year
      && utcCivilTime.getUTCMonth() === month - 1
      && utcCivilTime.getUTCDate() === day
      && utcCivilTime.getUTCHours() === hour
      && utcCivilTime.getUTCMinutes() === minute
      && utcCivilTime.getUTCSeconds() === second
    const offsetHour = match[7] === undefined ? 0 : Number(match[7])
    const offsetMinute = match[8] === undefined ? 0 : Number(match[8])
    if (!validCivilTime || offsetHour > 23 || offsetMinute > 59) {
      return { issue: error('invalid_timestamp', 'Timestamp does not identify a real instant.', 'timestamp') }
    }
    milliseconds = Date.parse(value)
  }

  const date = new Date(milliseconds)
  if (!Number.isFinite(milliseconds) || Number.isNaN(date.getTime())) {
    return { issue: error('invalid_timestamp', 'Timestamp does not identify a real instant.', 'timestamp') }
  }

  return { date, utc: date.toISOString() }
}

/** Validates a standard HTTP status without changing the source status value. */
export function validateStatusCode(rawValue: string): StatusCodeResult {
  const value = rawValue.trim()
  if (!/^\d+$/.test(value)) {
    return { issue: error('invalid_status_code', 'Status code must be an integer.', 'status_code') }
  }

  const statusCode = Number(value)
  if (!Number.isSafeInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    return {
      issue: error('invalid_status_code', 'Status code must be in the standard HTTP range 100–599.', 'status_code'),
    }
  }

  const slaHealth: SlaHealth = statusCode >= 200 && statusCode <= 299
    ? 'healthy'
    : statusCode >= 500
      ? 'unavailable'
      : 'unmapped'
  return { statusCode, slaHealth }
}

/** Converts a valid, non-negative duration to milliseconds without guessing values. */
export function normalizeLatency(rawValue: string, rawUnit: string): LatencyResult {
  const value = rawValue.trim()
  const unit = rawUnit.trim()

  if (unit !== 'ms' && unit !== 's') {
    return {
      latencyMs: null,
      issue: error('invalid_latency_unit', 'Latency unit must be exactly ms or s.', 'latency_unit'),
      convertedFromSeconds: false,
    }
  }
  if (value === '') {
    return {
      latencyMs: null,
      quality: 'missing_latency',
      issue: warning('missing_latency', 'Latency is blank and is excluded only from latency aggregates.', 'latency'),
      convertedFromSeconds: false,
    }
  }
  if (!DECIMAL.test(value)) {
    return {
      latencyMs: null,
      issue: error('invalid_latency', 'Latency must be a locale-invariant decimal.', 'latency'),
      convertedFromSeconds: false,
    }
  }
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) {
    return {
      latencyMs: null,
      issue: error('invalid_latency', 'Latency must be finite.', 'latency'),
      convertedFromSeconds: false,
    }
  }
  if (numericValue < 0) {
    return {
      latencyMs: null,
      quality: 'invalid_negative_latency',
      issue: warning('invalid_negative_latency', 'Negative latency is retained as status evidence but excluded from latency aggregates.', 'latency'),
      convertedFromSeconds: false,
    }
  }

  const latencyMs = unit === 's' ? numericValue * 1_000 : numericValue
  if (!Number.isFinite(latencyMs)) {
    return {
      latencyMs: null,
      issue: error('invalid_latency', 'Latency conversion produced a non-finite value.', 'latency'),
      convertedFromSeconds: false,
    }
  }
  return { latencyMs, quality: 'valid', convertedFromSeconds: unit === 's' }
}

export function validateHeader(header: readonly string[]): QualityIssue[] {
  const matches = header.length === EXPECTED_HEADER.length
    && header.every((value, index) => value === EXPECTED_HEADER[index])
  return matches
    ? []
    : [error('invalid_header', `CSV header must exactly match: ${EXPECTED_HEADER.join(',')}.`)]
}

function validateRequiredFields(raw: RawMonitoringRow): QualityIssue[] {
  return EXPECTED_HEADER
    .filter((field) => field !== 'latency' && raw[field].trim() === '')
    .map((field) => error('missing_required_field', `${field} is required.`, field))
}

function validQuarterHour(date: Date): boolean {
  return date.getUTCMinutes() % 15 === 0
    && date.getUTCSeconds() === 0
    && date.getUTCMilliseconds() === 0
}

function requiresUtcNormalization(rawTimestamp: string): boolean {
  return !rawTimestamp.trim().endsWith('Z')
}

/**
 * Validates one correctly-shaped data row. Missing and negative latency are
 * warnings because the report's valid HTTP status remains useful SLA evidence.
 */
export function validateRow(
  raw: RawMonitoringRow,
  datasetId: string,
  sourceRowNumber: number,
): RowValidationResult {
  const issues = validateRequiredFields(raw)
  const timestamp = parseTimestamp(raw.timestamp)
  const status = validateStatusCode(raw.status_code)
  const latency = normalizeLatency(raw.latency, raw.latency_unit)

  if (timestamp.issue) issues.push(timestamp.issue)
  if (timestamp.date && !validQuarterHour(timestamp.date)) {
    issues.push(error('invalid_timestamp_boundary', 'Timestamp must land on a 15-minute UTC boundary with zero seconds.', 'timestamp'))
  }
  if (status.issue) issues.push(status.issue)
  if (latency.issue) issues.push(latency.issue)
  const serviceId = raw.service_id.trim()
  const serviceName = raw.service_name.trim()
  if (serviceId !== '' && SERVICE_NAMES[serviceId] !== serviceName) {
    issues.push(error('invalid_service_mapping', 'service_id and service_name do not match a known dataset service.', 'service_name'))
  }

  if (status.slaHealth === 'unmapped') {
    issues.push(warning('unmapped_status_for_sla', 'Standard HTTP status is retained but needs an explicit SLA mapping.', 'status_code'))
  }

  const hasErrors = issues.some((issue) => issue.severity === 'error')
  if (hasErrors || !timestamp.utc || status.statusCode === undefined || !status.slaHealth) {
    return {
      valid: false,
      issues,
      timestampNormalized: Boolean(timestamp.utc && requiresUtcNormalization(raw.timestamp)),
      latencyConverted: latency.convertedFromSeconds,
    }
  }

  return {
    valid: true,
    issues,
    timestampNormalized: requiresUtcNormalization(raw.timestamp),
    latencyConverted: latency.convertedFromSeconds,
    record: {
      datasetId,
      sourceRowNumber,
      serviceId,
      serviceName,
      observedAtUtc: timestamp.utc,
      statusCode: status.statusCode,
      slaHealth: status.slaHealth,
      latencyMs: latency.latencyMs,
      latencyQuality: latency.quality ?? 'valid',
      latencyUnit: raw.latency_unit.trim() as 'ms' | 's',
      agent: raw.agent.trim(),
      region: raw.region.trim(),
      raw,
    },
  }
}
