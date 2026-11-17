import { useMemo, useState } from 'react'

import type { EntryRow } from '@/data/types'
import type { MappingVersion } from '@/data/reprocess-types'

type Props = {
  versions: MappingVersion[]
  version: MappingVersion
  statuses: string[]
  actions: string[]
  rows: EntryRow[]
  total: number
  filters: Record<string, string>
  onFilters: (filters: Record<string, string>) => void
  onAction: (action: string, row: EntryRow) => void
  onPickVersion: (versionId: string) => void
}

const FILTER_FIELDS = ['规则编号', '源字段名称', '目标字段名称']

export default function RulesPanel({
  versions,
  version,
  statuses,
  actions,
  rows,
  total,
  filters,
  onFilters,
  onAction,
  onPickVersion,
}: Props) {
  const [submitted, setSubmitted] = useState(filters)
  const shown = useMemo(
    () =>
      rows.filter((row) =>
        Object.entries(submitted).every(
          ([field, value]) => value.trim() === '' || String(row[field] ?? '').includes(value.trim()),
        ),
      ),
    [rows, submitted],
  )

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3 className="panel-title">映射规则</h3>
          <p className="panel-desc">
            字段映射 {version.versionId} · 映射规则按规则编号与目标字段一一对应；必填标识为「是」的规则在重算时要先通过必填处理，未通过不会写入增量重算清单。
          </p>
        </div>
        <label className="field-label">
          回查映射版本
          <select value={version.versionId} onChange={(event) => onPickVersion(event.target.value)}>
            {versions.map((item) => (
              <option key={item.versionId} value={item.versionId}>
                {item.versionId} · {item.label}（{item.status}）
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="status-legend">
        {statuses.map((status) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form
        className="filter-bar"
        onSubmit={(event) => {
          event.preventDefault()
          onFilters(filters)
          setSubmitted(filters)
        }}
      >
        {FILTER_FIELDS.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => onFilters({ ...filters, [field]: event.target.value })}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button
          className="btn ghost"
          type="button"
          onClick={() => {
            onFilters({})
            setSubmitted({})
          }}
        >
          重置条件
        </button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            <th>规则编号</th>
            <th>源字段名称</th>
            <th>目标字段名称</th>
            <th>数据类型转换</th>
            <th>默认填充值</th>
            <th>清洗表达式</th>
            <th>必填标识</th>
            <th>唯一性校验</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr key={`${version.versionId}-${String(row['规则编号'])}`}>
              <td className="mono">{row['规则编号']}</td>
              <td>{row['源字段名称']}</td>
              <td>{row['目标字段名称']}</td>
              <td>{row['数据类型转换'] || '—'}</td>
              <td>{row['默认填充值'] || '—'}</td>
              <td>{row['清洗表达式'] || '—'}</td>
              <td>{row['必填标识']}</td>
              <td>{row['唯一性校验']}</td>
              <td>{row.status}</td>
              <td className="row-actions">
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => onAction(action, row)}>
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {shown.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={10}>
                没有符合条件的映射规则，可调整规则编号 / 源字段 / 目标字段条件
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>
          共 {total} 条映射规则，当前筛选 {shown.length} 条；{version.versionId} 为{version.status}
        </span>
      </footer>
    </div>
  )
}
