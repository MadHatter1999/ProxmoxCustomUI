import { useEffect, useState } from 'react'
import { api } from '../api'
import type { TaskLogLine, TaskStatusInfo, TrackedTask } from '../types'

export default function TaskLog({ task, onDone, onDismiss }: {
  task: TrackedTask
  onDone?: (ok: boolean) => void
  onDismiss: () => void
}) {
  const [status, setStatus] = useState<TaskStatusInfo | null>(null)
  const [lines, setLines] = useState<string[]>([])

  useEffect(() => {
    let stop = false
    let finished = false
    const encoded = encodeURIComponent(task.upid)

    async function poll() {
      try {
        const st = await api<TaskStatusInfo>(`/nodes/${task.node}/tasks/${encoded}/status`)
        if (stop) return
        setStatus(st)
        const log = await api<TaskLogLine[]>(`/nodes/${task.node}/tasks/${encoded}/log`, {
          params: { start: 0, limit: 200 }
        })
        if (stop) return
        setLines(log.map(l => l.t).filter(t => t && t !== 'no content'))
        if (st.status === 'stopped' && !finished) {
          finished = true
          onDone?.(st.exitstatus === 'OK')
          return
        }
      } catch {
        /* transient poll error - keep trying */
      }
      if (!stop) setTimeout(poll, 2000)
    }
    poll()
    return () => { stop = true }
  }, [task.upid, task.node]) // eslint-disable-line react-hooks/exhaustive-deps

  const done = status?.status === 'stopped'
  const ok = status?.exitstatus === 'OK'
  const stateLabel = !done ? 'running' : ok ? 'finished OK' : `failed: ${status?.exitstatus}`

  return (
    <div className={`task-card ${done ? (ok ? 'task-ok' : 'task-fail') : ''}`}>
      <div className="task-head">
        <span className="task-title">
          {!done ? <span className="spinner" aria-hidden /> : <span aria-hidden>{ok ? '✔' : '✘'}</span>}{' '}
          {task.label} - {stateLabel}
        </span>
        <button className="ghost" onClick={onDismiss} aria-label="Dismiss task">✕</button>
      </div>
      {lines.length > 0 && (
        <pre className="task-log">{lines.slice(-8).join('\n')}</pre>
      )}
    </div>
  )
}
