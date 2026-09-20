export interface MonitoringCheck {
  datasetId: string
  timestamp: string
  serviceId: string
  serviceName: string
  service: string
  statusCode: number
  latencyMs: number
  agent: string
  region: string
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
export interface LogsResponse { logs: LogItem[]; pagination: { page: number; limit: number; total: number; totalPages: number } }
export interface ServiceStatistics { serviceId: string; serviceName: string; totalChecks: number; successfulChecks: number; failedChecks: number; availabilityPercent: number; averageLatencyMs: number | null; p95LatencyMs: number | null; slaStatus: 'met' | 'breached' }
export interface DashboardStats {
  totalChecks: number
  successfulChecks: number
  failedChecks: number
  availabilityPercent: number
  averageLatencyMs: number | null
  p95LatencyMs: number | null
  perService: ServiceStatistics[]
  slaStatus: 'met' | 'breached'
}
export interface ProcessingSummary { totalRows: number; insertedRows: number; duplicates: number; rejectedRows: number; issues: Record<string, number> }
