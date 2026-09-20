import type { DashboardStats, LogsResponse, ProcessingSummary } from '../types/monitoring'
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')
export interface LogFilters { date?: string; from?: string; to?: string; service?: string; page?: number; limit?: number }
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, init)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error?.message ?? 'The request could not be completed.')
  return payload as T
}
const queryString = (filters: LogFilters): string => { const params = new URLSearchParams(); Object.entries(filters).forEach(([key, value]) => { if (value !== undefined && value !== '') params.set(key, String(value)) }); const query = params.toString(); return query ? `?${query}` : '' }
export function uploadCsv(file: File): Promise<ProcessingSummary> { const body = new FormData(); body.append('file', file); return request<ProcessingSummary>('/imports', { method: 'POST', body }) }
export function getStats(filters: LogFilters = {}): Promise<DashboardStats> { return request<DashboardStats>(`/api/stats${queryString(filters)}`) }
export function getLogs(filters: LogFilters = {}): Promise<LogsResponse> { return request<LogsResponse>(`/api/logs${queryString(filters)}`) }

export { apiBaseUrl }
