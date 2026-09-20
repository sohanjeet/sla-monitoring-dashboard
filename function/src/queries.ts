import type { QueryResultRow } from 'pg'
import { getPool } from './db.js'

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100
const SLA_TARGET_PERCENT = 99.9

export interface QueryErrorDetails {
  statusCode: number
  code: string
  message: string
}

export class QueryError extends Error {
  constructor(readonly details: QueryErrorDetails) {
    super(details.message)
  }
}

export interface QueryParameters {
  date?: string | null
  from?: string | null
  to?: string | null
  service?: string | null
  page?: string | null
  limit?: string | null
}

interface DateFilter {
  start?: string
  endExclusive?: string
}

interface ParsedQuery {
  dateFilter: DateFilter
  serviceId?: string
  page: number
  pageSize: number
}

export interface LogItem {
  datasetId: string
  timestamp: string
  serviceId: string
  serviceName: string
  statusCode: number
  latencyMs: number | null
  agent: string
  region: string
}

export interface LogsResponse {
  logs: LogItem[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

export interface ServiceStatistics {
  serviceId: string
  serviceName: string
  totalChecks: number
  successfulChecks: number
  failedChecks: number
  availabilityPercent: number
  averageLatencyMs: number | null
  p95LatencyMs: number | null
  slaStatus: 'met' | 'breached'
}

export interface StatsResponse {
  totalChecks: number
  successfulChecks: number
  failedChecks: number
  availabilityPercent: number
  averageLatencyMs: number | null
  p95LatencyMs: number | null
  perService: ServiceStatistics[]
  slaStatus: 'met' | 'breached'
}

interface LogRow extends QueryResultRow {
  dataset_id: string
  observed_at: string | Date
  service_id: string
  service_name: string
  status_code: number
  latency_ms: string | number | null
  agent: string
  region: string
}

interface CountRow extends QueryResultRow {
  total: string | number
}

interface StatsRow extends QueryResultRow {
  service_id: string | null
  service_name: string | null
  total_checks: string | number
  successful_checks: string | number
  failed_checks: string | number
  availability_percent: string | number
  average_latency_ms: string | number | null
  p95_latency_ms: string | number | null
}

function invalid(code: string, message: string): never {
  throw new QueryError({ statusCode: 400, code, message })
}

function requiredDate(value: string, field: 'date' | 'from' | 'to'): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    invalid('invalid_date', `${field} must be an ISO date in YYYY-MM-DD format.`)
  }
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    invalid('invalid_date', `${field} must be a real calendar date.`)
  }
  return value
}

function dayStart(date: string): string {
  return `${date}T00:00:00.000Z`
}

function followingDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString()
}

function optionalNonBlank(value: string | null | undefined, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  const trimmed = value.trim()
  if (trimmed === '') invalid('invalid_parameter', `${field} must not be blank.`)
  return trimmed
}

function positiveInteger(value: string | null | undefined, field: string, fallback: number, maximum?: number): number {
  if (value === undefined || value === null) return fallback
  if (!/^\d+$/.test(value)) invalid('invalid_pagination', `${field} must be a positive integer.`)
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || (maximum !== undefined && number > maximum)) {
    invalid('invalid_pagination', maximum === undefined
      ? `${field} must be a positive integer.`
      : `${field} must be between 1 and ${maximum}.`)
  }
  return number
}

/** Parses the shared UTC-day filters used by both dashboard queries. */
export function parseQueryParameters(parameters: QueryParameters): ParsedQuery {
  const date = optionalNonBlank(parameters.date, 'date')
  const from = optionalNonBlank(parameters.from, 'from')
  const to = optionalNonBlank(parameters.to, 'to')

  if (date && (from || to)) {
    invalid('invalid_date_filter', 'Use date or a complete from/to range, not both.')
  }
  if ((from && !to) || (!from && to)) {
    invalid('invalid_date_filter', 'from and to must be provided together.')
  }

  let dateFilter: DateFilter = {}
  if (date) {
    const parsedDate = requiredDate(date, 'date')
    dateFilter = { start: dayStart(parsedDate), endExclusive: followingDay(parsedDate) }
  } else if (from && to) {
    const parsedFrom = requiredDate(from, 'from')
    const parsedTo = requiredDate(to, 'to')
    if (parsedFrom > parsedTo) invalid('invalid_date_range', 'from must be on or before to.')
    dateFilter = { start: dayStart(parsedFrom), endExclusive: followingDay(parsedTo) }
  }

  return {
    dateFilter,
    serviceId: optionalNonBlank(parameters.service, 'service'),
    page: positiveInteger(parameters.page, 'page', 1),
    pageSize: positiveInteger(parameters.limit, 'limit', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  }
}

function conditions(query: ParsedQuery): { clause: string, values: unknown[] } {
  const values: unknown[] = []
  const clauses: string[] = []
  if (query.dateFilter.start && query.dateFilter.endExclusive) {
    values.push(query.dateFilter.start, query.dateFilter.endExclusive)
    clauses.push(`c.observed_at >= $${values.length - 1} AND c.observed_at < $${values.length}`)
  }
  if (query.serviceId) {
    values.push(query.serviceId)
    clauses.push(`c.service_id = $${values.length}`)
  }
  return { clause: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values }
}

async function ensureSupportedService(serviceId: string | undefined): Promise<void> {
  if (!serviceId) return
  const result = await getPool().query<{ supported: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM services WHERE id = $1) AS supported',
    [serviceId],
  )
  if (!result.rows[0]?.supported) {
    throw new QueryError({
      statusCode: 400,
      code: 'unsupported_service',
      message: `Service "${serviceId}" is not available.`,
    })
  }
}

function numberValue(value: string | number): number {
  return Number(value)
}

function nullableNumber(value: string | number | null): number | null {
  return value === null ? null : Number(value)
}

function isoTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export async function getLogs(parameters: QueryParameters): Promise<LogsResponse> {
  const query = parseQueryParameters(parameters)
  await ensureSupportedService(query.serviceId)
  const filter = conditions(query)
  const pool = getPool()
  const totalResult = await pool.query<CountRow>(
    `SELECT COUNT(*) AS total
     FROM monitoring_checks c
     ${filter.clause}`,
    filter.values,
  )
  const total = numberValue(totalResult.rows[0]?.total ?? 0)
  const values = [...filter.values, query.pageSize, (query.page - 1) * query.pageSize]
  const rows = await pool.query<LogRow>(
    `SELECT c.dataset_id, c.observed_at, c.service_id, s.name AS service_name,
            c.status_code, c.latency_ms, c.agent, c.region
     FROM monitoring_checks c
     JOIN services s ON s.id = c.service_id
     ${filter.clause}
     ORDER BY c.observed_at ASC, c.service_id ASC, c.agent ASC,
              c.source_row_number ASC, c.dataset_id ASC, c.id ASC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  )

  return {
    logs: rows.rows.map((row) => ({
      datasetId: row.dataset_id,
      timestamp: isoTimestamp(row.observed_at),
      serviceId: row.service_id,
      serviceName: row.service_name,
      statusCode: row.status_code,
      latencyMs: nullableNumber(row.latency_ms),
      agent: row.agent,
      region: row.region,
    })),
    pagination: {
      page: query.page,
      limit: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    },
  }
}

const SLOT_STATISTICS_SQL = `
  WITH filtered_reports AS (
    SELECT c.dataset_id, c.service_id, s.name AS service_name, c.observed_at,
           c.status_code, c.latency_ms
    FROM monitoring_checks c
    JOIN services s ON s.id = c.service_id
    %FILTER%
  ), slot_reports AS (
    SELECT dataset_id, service_id, service_name, observed_at,
           BOOL_OR(status_code BETWEEN 200 AND 299) AS has_healthy,
           BOOL_OR(status_code BETWEEN 500 AND 599) AS has_unavailable,
           COUNT(DISTINCT latency_ms) FILTER (WHERE latency_ms IS NOT NULL) AS latency_value_count,
           MIN(latency_ms) FILTER (WHERE latency_ms IS NOT NULL) AS canonical_latency_ms
    FROM filtered_reports
    GROUP BY dataset_id, service_id, service_name, observed_at
  ), slots AS (
    SELECT service_id, service_name,
           CASE
             WHEN has_healthy AND NOT has_unavailable THEN 'healthy'
             WHEN has_unavailable AND NOT has_healthy THEN 'unavailable'
             ELSE NULL
           END AS sla_health,
           CASE WHEN latency_value_count = 1 THEN canonical_latency_ms ELSE NULL END AS latency_ms
    FROM slot_reports
  )
  SELECT service_id, service_name,
         COUNT(*) FILTER (WHERE sla_health IS NOT NULL) AS total_checks,
         COUNT(*) FILTER (WHERE sla_health = 'healthy') AS successful_checks,
         COUNT(*) FILTER (WHERE sla_health = 'unavailable') AS failed_checks,
         COALESCE(ROUND(
           100.0 * COUNT(*) FILTER (WHERE sla_health = 'healthy')
           / NULLIF(COUNT(*) FILTER (WHERE sla_health IS NOT NULL), 0),
           3
         ), 0) AS availability_percent,
         AVG(latency_ms) FILTER (WHERE latency_ms IS NOT NULL) AS average_latency_ms,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
           FILTER (WHERE latency_ms IS NOT NULL) AS p95_latency_ms
  FROM slots
  GROUP BY GROUPING SETS ((service_id, service_name), ())
  ORDER BY service_id NULLS FIRST
`

function toStatistics(row: StatsRow): ServiceStatistics {
  const availabilityPercent = numberValue(row.availability_percent)
  return {
    serviceId: row.service_id ?? '',
    serviceName: row.service_name ?? '',
    totalChecks: numberValue(row.total_checks),
    successfulChecks: numberValue(row.successful_checks),
    failedChecks: numberValue(row.failed_checks),
    availabilityPercent,
    averageLatencyMs: nullableNumber(row.average_latency_ms),
    p95LatencyMs: nullableNumber(row.p95_latency_ms),
    slaStatus: availabilityPercent >= SLA_TARGET_PERCENT ? 'met' : 'breached',
  }
}

export async function getStats(parameters: QueryParameters): Promise<StatsResponse> {
  const query = parseQueryParameters(parameters)
  await ensureSupportedService(query.serviceId)
  const filter = conditions(query)
  const result = await getPool().query<StatsRow>(
    SLOT_STATISTICS_SQL.replace('%FILTER%', filter.clause),
    filter.values,
  )
  const overallRow = result.rows.find((row) => row.service_id === null)
  const overall = overallRow ? toStatistics(overallRow) : {
    totalChecks: 0,
    successfulChecks: 0,
    failedChecks: 0,
    availabilityPercent: 0,
    averageLatencyMs: null,
    p95LatencyMs: null,
    slaStatus: 'breached' as const,
  }

  return {
    ...overall,
    perService: result.rows
      .filter((row) => row.service_id !== null)
      .map(toStatistics),
  }
}
