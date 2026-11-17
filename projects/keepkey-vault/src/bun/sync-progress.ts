import type { SyncProgress, SyncStage } from '../shared/sync-progress'

export function createSyncProgressTracker(publish: (value: SyncProgress) => void, now = Date.now) {
  const recent: SyncProgress[] = []
  let current: (() => SyncProgress) | undefined
  return {
    snapshot: () => current?.() ?? recent.at(-1) ?? null,
    recent: () => recent.slice(-10),
    async run<T>(work: (progress: {
      phase: (stage: SyncStage, total?: number) => void
      pause: () => void
      task: <R>(label: string, work: () => Promise<R>, units?: number, failed?: (result: R) => number) => Promise<R>
    }) => Promise<T>): Promise<T> {
      const startedAt = now(), id = crypto.randomUUID()
      let stage: SyncStage = 'preparing', status: SyncProgress['status'] = 'running'
      let finishedAt: number | undefined
      let total = 0, completed = 0, failed = 0
      const tasks: SyncProgress['tasks'] = [], active = new Map<string, number>()
      const snapshot = (): SyncProgress => ({id,startedAt,updatedAt:finishedAt ?? now(),elapsedMs:Math.max(0,(finishedAt ?? now())-startedAt),stage,status,total,completed,failed,
        percent: total ? Math.min(100,Math.floor(completed/total*100)) : undefined,
        active: [...active].map(([label,at])=>({label,elapsedMs:Math.max(0,now()-at)})),tasks:tasks.slice()})
      current = snapshot
      const emit = () => { if (current !== snapshot) return; try { publish(snapshot()) } catch {} }
      const timer = setInterval(emit,1000); timer.unref?.()
      emit()
      try {
        const value = await work({
          phase(next, count=0) { stage=next; total=count; completed=0; failed=0; emit() },
          pause() { status='paused'; emit() },
          async task(label, action, units=1, countFailed) {
            const at=now(), taskStage=stage; active.set(label,at); emit()
            let failures=0
            try { const result=await action(); failures=countFailed?.(result) ?? 0; return result }
            catch(error) { failures=units; throw error }
            finally {
              active.delete(label); completed+=units; failed+=failures
              tasks.push({label,stage:taskStage,durationMs:Math.max(0,now()-at),units,failed:failures}); emit()
            }
          },
        })
        if(status==='running')status=tasks.some(task=>task.failed>0)?'partial':'complete'
        return value
      } catch(error) { status='failed'; throw error }
      finally { finishedAt=now(); clearInterval(timer); emit(); recent.push(snapshot()); if(recent.length>10)recent.shift() }
    },
  }
}
