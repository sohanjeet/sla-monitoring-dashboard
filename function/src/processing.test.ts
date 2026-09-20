import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { processCsv } from './cleaner.js'
import { normalizeLatency, parseTimestamp } from './validator.js'

const header = 'service_id,service_name,timestamp,status_code,latency,latency_unit,agent,region'

function csv(...rows: string[]): string {
  return [header, ...rows].join('\n')
}

function availability(records: ReturnType<typeof processCsv>['records']): { healthy: number, unavailable: number, usable: number } {
  const healthBySlot = new Map<string, Set<string>>()
  for (const record of records) {
    const key = `${record.datasetId}\u0000${record.serviceId}\u0000${record.observedAtUtc}`
    const health = healthBySlot.get(key) ?? new Set<string>()
    health.add(record.slaHealth)
    healthBySlot.set(key, health)
  }

  let healthy = 0
  let unavailable = 0
  for (const health of healthBySlot.values()) {
    if (health.size !== 1) continue
    if (health.has('healthy')) healthy += 1
    if (health.has('unavailable')) unavailable += 1
  }
  return { healthy, unavailable, usable: healthy + unavailable }
}

test('normalizes the three timestamp formats observed in the supplied CSVs', () => {
  assert.equal(parseTimestamp('2025-04-11T17:30:00Z').utc, '2025-04-11T17:30:00.000Z')
  assert.equal(parseTimestamp('2025-04-12T14:15:00+05:30').utc, '2025-04-12T08:45:00.000Z')
  assert.equal(parseTimestamp('1746938700').utc, '2025-05-11T04:45:00.000Z')
})

test('normalizes milliseconds and seconds latency without inventing missing or negative values', () => {
  assert.deepEqual(normalizeLatency('125.5', 'ms'), {
    latencyMs: 125.5,
    quality: 'valid',
    convertedFromSeconds: false,
  })
  assert.deepEqual(normalizeLatency('0.625', 's'), {
    latencyMs: 625,
    quality: 'valid',
    convertedFromSeconds: true,
  })
  assert.equal(normalizeLatency('', 'ms').latencyMs, null)
  assert.equal(normalizeLatency('', 'ms').quality, 'missing_latency')
  assert.equal(normalizeLatency('-286', 'ms').latencyMs, null)
  assert.equal(normalizeLatency('-286', 'ms').quality, 'invalid_negative_latency')
})

test('retains valid SLA evidence while rejecting only data findings that cannot be used', () => {
  const result = processCsv(csv(
    'svc-auth,auth-api,2025-04-11T17:30:00Z,200,125,ms,agent-1,ap-south-1',
    'svc-search,search-api,2025-04-12T14:15:00+05:30,200,0.625,s,agent-1,ap-south-1',
    'svc-payments,payments-api,1746938700,200,,ms,agent-2,ap-south-1',
    'svc-notify,notify-worker,2025-04-11T17:45:00Z,200,-286,ms,agent-1,ap-south-1',
    'svc-reports,reports-api,2025-04-11T18:00:00Z,999,200,ms,agent-1,ap-south-1',
    'svc-auth,auth-api,2025-04-11T17:30:00Z,200,125,ms,agent-1,ap-south-1',
    'svc-auth,auth-api,2025-04-11T18:15:00Z,200,130,ms,,ap-south-1',
  ), 'fixture')

  assert.equal(result.totalRows, 7)
  assert.equal(result.validRows, 4)
  assert.equal(result.rejectedRows, 3)
  assert.equal(result.duplicates, 1)
  assert.deepEqual(result.issueCounts, {
    missing_latency: 1,
    invalid_negative_latency: 1,
    invalid_status_code: 1,
    duplicate_exact: 1,
    missing_required_field: 1,
  })
  assert.equal(result.records[1].observedAtUtc, '2025-04-12T08:45:00.000Z')
  assert.equal(result.records[1].latencyMs, 625)
  assert.equal(result.records[2].latencyQuality, 'missing_latency')
  assert.equal(result.records[3].latencyQuality, 'invalid_negative_latency')
})

test('the supplied 9-day dataset yields the documented duplicate-aware availability population', () => {
  const source = readFileSync(resolve(process.cwd(), '..', '..', 'monitoring_checks_9d_seed101.csv'), 'utf8')
  const result = processCsv(source, '9d')
  const totals = availability(result.records)

  assert.equal(result.totalRows, 4_672)
  assert.equal(result.issueCounts.invalid_status_code, 1)
  assert.equal(result.issueCounts.missing_latency, 56)
  assert.equal(result.issueCounts.invalid_negative_latency, 1)
  assert.deepEqual(totals, { healthy: 4_278, unavailable: 41, usable: 4_319 })
  assert.equal(Number((100 * totals.healthy / totals.usable).toFixed(3)), 99.051)
})

test('a failed availability population remains a breach rather than being counted as healthy', () => {
  const result = processCsv(csv(
    'svc-auth,auth-api,2025-04-11T17:30:00Z,200,125,ms,agent-1,ap-south-1',
    'svc-notify,notify-worker,2025-04-11T17:30:00Z,500,125,ms,agent-1,ap-south-1',
  ), 'failure-fixture')
  const totals = availability(result.records)

  assert.deepEqual(totals, { healthy: 1, unavailable: 1, usable: 2 })
  assert.equal(100 * totals.healthy / totals.usable < 99.9, true)
})
