import { useMemo } from 'react'

import type { ManifestEntry, ReprocessState } from '@/data/reprocess-types'
import type { StorageFieldRow } from '@/api/reprocess-service'

export function statusBadge(status: string) {
  if (status === '已写入' || status === '已完成' || status === '已复核') return 'badge green'
  if (status === '写入失败' || status === '已中断' || status === '异常') return 'badge red'
  if (status === '待写入' || status === '待复核' || status === '部分回写') return 'badge amber'
  return 'badge gray'
}

export function bizBadge(status: string) {
  if (status === '正常') return 'badge green'
  if (status === '已复核') return 'badge blue'
  if (status === '待复核') return 'badge amber'
  return 'badge red'
}

export function FieldChips({ fields }: { fields: string[] }) {
  if (fields.length === 0) return <span className="muted">—</span>
  return (
    <span className="cell-list">
      {fields.map((field) => (
        <span key={field} className="badge">{field}</span>
      ))}
    </span>
  )
}

export function useFilteredEntries(
  state: ReprocessState,
  planId: string | undefined,
  search: { targetField: string; recordId: string; ruleNo: string; status: string },
): ManifestEntry[] {
  return useMemo(() => {
    const plan = planId ? state.plans[planId] : undefined
    if (!plan) return []
    return plan.entries.filter((entry) => {
      if (search.targetField && !entry.targetField.includes(search.targetField.trim())) return false
      if (search.recordId && !entry.recordId.includes(search.recordId.trim())) return false
      if (search.ruleNo && !entry.ruleNo.includes(search.ruleNo.trim())) return false
      if (search.status && entry.status !== search.status) return false
      return true
    })
  }, [state.plans, planId, search.targetField, search.recordId, search.ruleNo, search.status])
}

export function useFilteredStorageRows(rows: StorageFieldRow[], search: { targetField: string; recordId: string; status: string }) {
  return useMemo(
    () =>
      rows.filter((row) => {
        if (search.targetField && !row.targetField.includes(search.targetField.trim())) return false
        if (search.recordId && !row.recordId.includes(search.recordId.trim())) return false
        if (search.status && row.status !== search.status) return false
        return true
      }),
    [rows, search.targetField, search.recordId, search.status],
  )
}
