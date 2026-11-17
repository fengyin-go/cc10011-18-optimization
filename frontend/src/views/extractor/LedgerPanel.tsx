import { useMemo, useState } from 'react'

import {
  changeSummary,
  reviewRecord,
  saveExtractorSearch,
  saveExtractorUi,
} from '@/api/reprocess-service'
import type { FieldDiff, ReprocessState } from '@/data/reprocess-types'
import { recordSummary } from '@/data/reprocess-seed'

import { FieldChips, bizBadge, statusBadge, useFilteredEntries } from '../shared/reprocess-ui'

type Props = {
  state: ReprocessState
  versionId: string
  planReady: boolean
  unchangedFieldCount: number
  diffFields: FieldDiff[]
  onResult: (message: string, ok: boolean) => void
}

const ENTRY_STATUS = ['待写入', '已写入', '写入失败', '已跳过']

export default function LedgerPanel({ state, versionId, planReady, unchangedFieldCount, diffFields, onResult }: Props) {
  const { search, focusRecordId } = state.ui.extractor
  const plan = state.plans[versionId]
  const entries = useFilteredEntries(state, plan ? versionId : undefined, search)
  const [expanded, setExpanded] = useState<string | null>(null)

  const workbench = useMemo(
    () =>
      state.records
        .map((record) => recordSummary(state, versionId, record.recordId))
        .filter((item) => item !== null)
        .map((item) => ({ ...item!, focus: item!.recordId === focusRecordId })),
    [state, versionId, focusRecordId],
  )

  function focus(recordId: string) {
    saveExtractorUi({ focusRecordId: recordId })
  }

  function review(recordId: string) {
    const result = reviewRecord(recordId, '已复核')
    onResult(result.message, result.ok)
  }

  const changedRecords = workbench.filter((item) => item.replaceFields.length > 0)
  const manualRecords = state.records.filter((record) => (state.dataset.rows[record.recordId]?.manualEdits.length ?? 0) > 0)

  return (
    <div>
      <div className="panel">
        <div className="panel-head">
          <div>
            <h3 className="panel-title">字段映射增量重算清单</h3>
            <p className="panel-desc">
              按受影响记录整行展开核对：受影响目标字段、待替换列、保留列与回写状态一目了然。点记录行可定位，筛选条件会随页面保存，重进后仍能回到同一记录。
            </p>
          </div>
          <span className={`badge ${planReady ? 'blue' : 'gray'}`}>{plan ? `批次 ${plan.runId}` : '清单未生成'}</span>
        </div>

        <div className="toolbar">
          <label className="field-label">
            目标字段
            <input
              value={search.targetField}
              placeholder="按目标字段检索"
              list="target-field-options"
              onChange={(event) => saveExtractorSearch({ targetField: event.target.value })}
            />
          </label>
          <datalist id="target-field-options">
            {diffFields.map((field) => (
              <option key={field.targetField} value={field.targetField} />
            ))}
          </datalist>
          <label className="field-label">
            记录编号
            <input
              value={search.recordId}
              placeholder="按记录编号检索"
              onChange={(event) => saveExtractorSearch({ recordId: event.target.value })}
            />
          </label>
          <label className="field-label">
            规则编号
            <input
              value={search.ruleNo}
              placeholder="按规则编号检索"
              onChange={(event) => saveExtractorSearch({ ruleNo: event.target.value })}
            />
          </label>
          <label className="field-label">
            清单状态
            <select value={search.status} onChange={(event) => saveExtractorSearch({ status: event.target.value })}>
              <option value="">全部</option>
              {ENTRY_STATUS.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <span className="spacer" />
          <button
            className="btn ghost"
            type="button"
            onClick={() => saveExtractorSearch({ targetField: '', recordId: '', ruleNo: '', status: '' })}
          >
            重置条件
          </button>
        </div>

        {focusRecordId && (
          <p className="hint">
            当前定位记录：<strong>{focusRecordId}</strong>
            {recordSummary(state, versionId, focusRecordId) ? `（${recordSummary(state, versionId, focusRecordId)?.bizStatus}）` : ''}
          </p>
        )}

        <table className="mini-table">
          <thead>
            <tr>
              <th>记录</th>
              <th>业务日期</th>
              <th>受影响字段</th>
              <th>待替换列</th>
              <th>保留列</th>
              <th>清单状态</th>
              <th>业务状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {workbench.map((item) => (
              <tr
                key={item.recordId}
                className={`${item.focus ? 'row-focus' : ''} clickable`}
                onClick={() => focus(item.recordId)}
              >
                <td className="mono nowrap">{item.recordId}</td>
                <td className="nowrap">{item.bizDate}</td>
                <td><FieldChips fields={item.affectedFields} /></td>
                <td><FieldChips fields={item.replaceFields} /></td>
                <td className="hint">{item.preservedFields.join('、')}</td>
                <td><span className={statusBadge(item.recomputeStatus)}>{item.recomputeStatus}</span></td>
                <td><span className={bizBadge(item.bizStatus)}>{item.bizStatus}</span></td>
                <td>
                  <button
                    className="link"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      review(item.recordId)
                    }}
                    disabled={item.bizStatus === '已复核'}
                  >
                    标记已复核
                  </button>
                </td>
              </tr>
            ))}
            {workbench.length === 0 && (
              <tr>
                <td colSpan={8} className="empty-state">还没有重算清单，先在上方执行「按目标字段合并差异后重算」</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <h3 className="panel-title">清单明细（字段级）</h3>
            <p className="panel-desc">
              共 {plan?.entries.length ?? 0} 条，当前筛选出 {entries.length} 条。旧结果、新字段差异和待替换列都在这里，替换失败时整批不落盘。
            </p>
          </div>
          <span className="hint">未变化列 {unchangedFieldCount} 列保持原结果</span>
        </div>
        <table className="mini-table">
          <thead>
            <tr>
              <th>记录</th>
              <th>目标字段</th>
              <th>规则编号</th>
              <th>变更类型</th>
              <th>上一版完整结果</th>
              <th>本次重算结果</th>
              <th>写入策略</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {entries.slice(0, 200).map((entry) => (
              <tr key={entry.id} className={entry.recordId === focusRecordId ? 'row-focus' : ''}>
                <td className="mono nowrap">{entry.recordId}</td>
                <td className="nowrap">{entry.targetField}</td>
                <td className="mono">{entry.ruleNo}</td>
                <td><span className="badge amber">{changeSummary(entry.changeTypes)}</span></td>
                <td className="hint">{entry.oldValue || '（空）'}</td>
                <td className={entry.changed ? 'ok-text' : 'hint'}>{entry.newValue || '（空）'}</td>
                <td><span className={entry.strategy === '整行' ? 'badge red' : 'badge blue'}>{entry.strategy}</span></td>
                <td>
                  <span className={statusBadge(entry.status)}>{entry.status}</span>
                  {entry.message && (
                    <button className="link" type="button" style={{ marginLeft: 6 }} onClick={() => setExpanded(entry.id)}>
                      说明
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={8} className="empty-state">{plan ? '没有符合条件的清单记录' : '清单尚未生成'}</td>
              </tr>
            )}
          </tbody>
        </table>
        {expanded && (
          <p className="hint" style={{ marginTop: 8 }}>
            说明（{expanded}）：{plan?.entries.find((entry) => entry.id === expanded)?.message ?? '—'}
            <button className="link" type="button" style={{ marginLeft: 8 }} onClick={() => setExpanded(null)}>
              收起
            </button>
          </p>
        )}
        {entries.length > 200 && <p className="hint">仅展示前 200 条，请用筛选条件缩小范围。</p>}
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <h3 className="panel-title">人工修订与未变化列核对</h3>
            <p className="panel-desc">含人工修订的列不参与字段级静默覆盖，保留上一版完整结果；未变化列按上一版引用。业务状态由字段映射用户复核。</p>
          </div>
          <span className="hint">受影响记录 {changedRecords.length} 条 / 人工修订 {manualRecords.length} 条</span>
        </div>
        <table className="mini-table">
          <thead>
            <tr>
              <th>记录</th>
              <th>人工修订列</th>
              <th>处理口径</th>
              <th>业务状态</th>
              <th>复核</th>
            </tr>
          </thead>
          <tbody>
            {manualRecords.map((record) => {
              const rowData = state.dataset.rows[record.recordId]
              const summary = recordSummary(state, versionId, record.recordId)
              return (
                <tr key={record.recordId} className={record.recordId === focusRecordId ? 'row-focus' : ''}>
                  <td className="mono">{record.recordId}</td>
                  <td><FieldChips fields={rowData?.manualEdits ?? []} /></td>
                  <td className="hint">按上一版完整结果保留，清单状态「已跳过」，不写入</td>
                  <td><span className={bizBadge(summary?.bizStatus ?? '正常')}>{summary?.bizStatus ?? '正常'}</span></td>
                  <td>
                    <button className="link" type="button" onClick={() => review(record.recordId)} disabled={summary?.bizStatus === '已复核'}>
                      标记已复核
                    </button>
                  </td>
                </tr>
              )
            })}
            {manualRecords.length === 0 && (
              <tr>
                <td colSpan={5} className="empty-state">本批没有人工修订列</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
