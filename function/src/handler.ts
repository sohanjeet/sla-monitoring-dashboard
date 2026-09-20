import type { PoolClient } from 'pg'
import { getPool } from './db.js'
import { processCsv } from './cleaner.js'
import { QueryError, getLogs, getStats } from './queries.js'
import type { NormalizedMonitoringRow, ProcessingResult, RejectedRow } from './types.js'

const DEFAULT_MAX_UPLOAD_BYTES = 4 * 1024 * 1024
const INSERT_BATCH_SIZE = 500

export interface FunctionResponse {
  statusCode: number
  body: string
  headers?: Record<string, string>
}

/** The subset of an API Gateway HTTP API v2 event used by this function. */
export interface ApiGatewayUploadEvent {
  requestContext?: { http?: { method?: string, path?: string } }
  headers?: Record<string, string | undefined>
  rawPath?: string
  queryStringParameters?: Record<string, string | undefined> | null
  body?: string | null
  isBase64Encoded?: boolean
}

interface Upload {
  filename: string
  bytes: Buffer
}

interface ImportSummary {
  totalRows: number
  insertedRows: number
  duplicates: number
  rejectedRows: number
  issues: Record<string, number>
}

class UploadError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function json(statusCode: number, value: unknown): FunctionResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(value),
  }
}

function header(headers: ApiGatewayUploadEvent['headers'], name: string): string | undefined {
  if (!headers) return undefined
  const expected = name.toLowerCase()
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === expected)
  return entry?.[1]
}

function maxUploadBytes(): number {
  const configured = process.env.MAX_UPLOAD_BYTES
  if (!configured) return DEFAULT_MAX_UPLOAD_BYTES
  const parsed = Number(configured)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 25 * 1024 * 1024
    ? parsed
    : DEFAULT_MAX_UPLOAD_BYTES
}

function rejectUnsupportedFile(message: string): never {
  throw new UploadError(415, 'unsupported_file', message)
}

function validateFilename(filename: string): string {
  const trimmed = filename.trim()
  if (trimmed === '' || !/\.csv$/i.test(trimmed)) {
    rejectUnsupportedFile('Only files with a .csv filename are supported.')
  }
  // Prevent untrusted filenames from being written to logs or database rows as paths.
  return trimmed.replaceAll(/[\\/]/g, '_').slice(0, 255)
}

function decodeRequestBody(event: ApiGatewayUploadEvent): Buffer {
  if (!event.body) throw new UploadError(400, 'missing_upload', 'A CSV upload is required.')

  const encoded = event.isBase64Encoded === true
  const bytes = encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body, 'utf8')
  if (bytes.length === 0) throw new UploadError(400, 'empty_upload', 'The uploaded file is empty.')
  if (bytes.length > maxUploadBytes()) {
    throw new UploadError(413, 'upload_too_large', `Uploads may not exceed ${maxUploadBytes()} bytes.`)
  }
  return bytes
}

function isCsvMediaType(contentType: string): boolean {
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase()
  return mediaType === 'text/csv' || mediaType === 'application/csv'
}

async function parseMultipartUpload(contentType: string, bytes: Buffer): Promise<Upload> {
  let form: FormData
  try {
    form = await new Request('https://upload.invalid', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: bytes,
    }).formData()
  } catch {
    throw new UploadError(400, 'invalid_multipart', 'The multipart upload could not be parsed.')
  }

  const files = form.getAll('file')
  if (files.length !== 1 || typeof files[0] === 'string') {
    throw new UploadError(400, 'missing_upload', 'Submit exactly one CSV file using the "file" form field.')
  }

  const file = files[0]
  const filename = validateFilename(file.name)
  if (file.type !== '' && !isCsvMediaType(file.type)) {
    rejectUnsupportedFile('The uploaded file must have a text/csv or application/csv media type.')
  }
  const fileBytes = Buffer.from(await file.arrayBuffer())
  if (fileBytes.length === 0) throw new UploadError(400, 'empty_upload', 'The uploaded file is empty.')
  if (fileBytes.length > maxUploadBytes()) {
    throw new UploadError(413, 'upload_too_large', `Uploads may not exceed ${maxUploadBytes()} bytes.`)
  }
  return { filename, bytes: fileBytes }
}

async function extractUpload(event: ApiGatewayUploadEvent): Promise<Upload> {
  const contentType = header(event.headers, 'content-type')
  if (!contentType) rejectUnsupportedFile('A CSV content type is required.')

  const contentLength = header(event.headers, 'content-length')
  if (contentLength && Number(contentLength) > maxUploadBytes()) {
    throw new UploadError(413, 'upload_too_large', `Uploads may not exceed ${maxUploadBytes()} bytes.`)
  }

  const bytes = decodeRequestBody(event)
  if (contentType.toLowerCase().startsWith('multipart/form-data;')) {
    return parseMultipartUpload(contentType, bytes)
  }
  if (!isCsvMediaType(contentType)) {
    rejectUnsupportedFile('Only text/csv, application/csv, or multipart CSV uploads are supported.')
  }

  return {
    filename: validateFilename(header(event.headers, 'x-file-name') ?? 'upload.csv'),
    bytes,
  }
}

function decodeCsv(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new UploadError(400, 'invalid_encoding', 'CSV files must be valid UTF-8 text.')
  }
}

function recordsValues(records: readonly NormalizedMonitoringRow[]): unknown[] {
  return records.flatMap((record) => [
    record.datasetId,
    record.serviceId,
    record.observedAtUtc,
    record.statusCode,
    record.latencyMs,
    record.agent,
    record.region,
    record.sourceRowNumber,
    record.raw.timestamp,
    record.raw.latency,
    record.latencyUnit,
    record.latencyQuality,
  ])
}

async function insertRecords(client: PoolClient, records: readonly NormalizedMonitoringRow[]): Promise<void> {
  for (let offset = 0; offset < records.length; offset += INSERT_BATCH_SIZE) {
    const batch = records.slice(offset, offset + INSERT_BATCH_SIZE)
    const placeholders = batch.map((_, rowIndex) => {
      const first = rowIndex * 12
      return `(${Array.from({ length: 12 }, (_, index) => `$${first + index + 1}`).join(', ')})`
    }).join(', ')
    const result = await client.query<{ source_row_number: number }>(
      `INSERT INTO monitoring_checks (
        dataset_id, service_id, observed_at, status_code, latency_ms, agent, region,
        source_row_number, raw_timestamp, raw_latency, latency_unit, latency_quality
      ) VALUES ${placeholders}
      ON CONFLICT (dataset_id, source_row_number) DO NOTHING
      RETURNING source_row_number`,
      recordsValues(batch),
    )
    if (result.rowCount !== batch.length) {
      throw new Error('A monitoring row could not be inserted; the import was rolled back.')
    }
  }
}

function rejectionValues(datasetId: string, rejectedRows: readonly RejectedRow[]): unknown[] {
  return rejectedRows.flatMap((row) => [
    datasetId,
    row.sourceRowNumber,
    [...new Set(row.issues.map((issue) => issue.code))].join(','),
    JSON.stringify(row.rawRecord),
  ])
}

async function insertRejections(client: PoolClient, datasetId: string, rejectedRows: readonly RejectedRow[]): Promise<void> {
  for (let offset = 0; offset < rejectedRows.length; offset += INSERT_BATCH_SIZE) {
    const batch = rejectedRows.slice(offset, offset + INSERT_BATCH_SIZE)
    const placeholders = batch.map((_, rowIndex) => {
      const first = rowIndex * 4
      return `(${Array.from({ length: 4 }, (_, index) => `$${first + index + 1}`).join(', ')})`
    }).join(', ')
    await client.query(
      `INSERT INTO import_rejections (dataset_id, source_row_number, rejection_reason, raw_record)
       VALUES ${placeholders}`,
      rejectionValues(datasetId, batch),
    )
  }
}

async function persistImport(filename: string, processing: ProcessingResult): Promise<ImportSummary> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const dataset = await client.query<{ id: string }>(
      'INSERT INTO datasets (source_filename) VALUES ($1) RETURNING id',
      [filename],
    )
    const datasetId = dataset.rows[0].id
    const records = processing.records.map((record) => ({ ...record, datasetId }))
    const services = [...new Map(records.map((record) => [record.serviceId, record.serviceName])).entries()]
    if (services.length > 0) {
      await client.query(
        `INSERT INTO services (id, name) VALUES ${services.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`).join(', ')}
         ON CONFLICT (id) DO NOTHING`,
        services.flatMap(([id, name]) => [id, name]),
      )
    }
    await insertRecords(client, records)
    await insertRejections(client, datasetId, processing.rejected)
    await client.query('COMMIT')

    return {
      totalRows: processing.totalRows,
      insertedRows: records.length,
      duplicates: processing.duplicates,
      rejectedRows: processing.rejectedRows,
      issues: processing.issueCounts,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/**
 * AWS Lambda/API Gateway HTTP API v2 handler. It accepts either a browser
 * multipart upload (`file`) or a raw UTF-8 CSV body, making it portable to
 * other request-to-Lambda adapters without retaining request state.
 */
export async function handler(event: ApiGatewayUploadEvent): Promise<FunctionResponse> {
  const path = event.rawPath ?? event.requestContext?.http?.path
  if (path === '/api/logs' || path === '/api/stats') {
    if (event.requestContext?.http?.method !== 'GET') {
      return json(405, { error: { code: 'method_not_allowed', message: 'Use GET for dashboard queries.' } })
    }
    try {
      const parameters = event.queryStringParameters ?? {}
      return json(200, path === '/api/logs' ? await getLogs(parameters) : await getStats(parameters))
    } catch (error) {
      if (error instanceof QueryError) {
        return json(error.details.statusCode, { error: { code: error.details.code, message: error.details.message } })
      }
      console.error('Dashboard query failed', error)
      return json(500, { error: { code: 'query_failed', message: 'The dashboard query could not be completed.' } })
    }
  }

  if (event.requestContext?.http?.method && event.requestContext.http.method !== 'POST') {
    return json(405, { error: { code: 'method_not_allowed', message: 'Use POST to upload a CSV file.' } })
  }

  try {
    const upload = await extractUpload(event)
    const processing = processCsv(decodeCsv(upload.bytes), 'pending')
    if (processing.totalRows === 0) {
      throw new UploadError(422, 'empty_csv', 'The CSV must contain a header and at least one data row.')
    }
    const summary = await persistImport(upload.filename, processing)
    return json(201, summary)
  } catch (error) {
    if (error instanceof UploadError) {
      return json(error.statusCode, { error: { code: error.code, message: error.message } })
    }
    console.error('CSV import failed', error)
    return json(500, { error: { code: 'import_failed', message: 'The import could not be completed.' } })
  }
}
