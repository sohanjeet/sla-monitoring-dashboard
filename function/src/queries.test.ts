import assert from 'node:assert/strict'
import test from 'node:test'
import { QueryError, parseQueryParameters } from './queries.js'

test('UTC date filters include both requested calendar-date boundaries', () => {
  const single = parseQueryParameters({ date: '2025-04-10' })
  assert.deepEqual(single.dateFilter, {
    start: '2025-04-10T00:00:00.000Z',
    endExclusive: '2025-04-11T00:00:00.000Z',
  })

  const range = parseQueryParameters({ from: '2025-04-10', to: '2025-04-12' })
  assert.deepEqual(range.dateFilter, {
    start: '2025-04-10T00:00:00.000Z',
    endExclusive: '2025-04-13T00:00:00.000Z',
  })
})

test('invalid or reversed date ranges fail before database access', () => {
  assert.throws(
    () => parseQueryParameters({ from: '2025-04-12', to: '2025-04-10' }),
    (error: unknown) => error instanceof QueryError && error.details.code === 'invalid_date_range',
  )
  assert.throws(
    () => parseQueryParameters({ date: '2025-02-30' }),
    (error: unknown) => error instanceof QueryError && error.details.code === 'invalid_date',
  )
})
