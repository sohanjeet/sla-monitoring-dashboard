import { getStats, type QueryParameters, type StatsResponse } from './queries.js'

/** Backwards-compatible entry point for the database-backed statistics query. */
export async function calculateStats(parameters: QueryParameters): Promise<StatsResponse> {
  return getStats(parameters)
}

export { getStats, type QueryParameters, type StatsResponse } from './queries.js'
