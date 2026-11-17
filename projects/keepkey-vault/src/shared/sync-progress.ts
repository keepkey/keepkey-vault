export type SyncStage = 'preparing' | 'addresses' | 'balances' | 'finalizing'
export interface SyncTask { label: string; stage: SyncStage; durationMs: number; units: number; failed: number }
export interface SyncProgress {
  id: string; startedAt: number; updatedAt: number; elapsedMs: number
  stage: SyncStage; status: 'running' | 'complete' | 'partial' | 'failed' | 'paused'
  total: number; completed: number; failed: number; percent?: number
  active: Array<{label: string; elapsedMs: number}>
  tasks: SyncTask[]
}
