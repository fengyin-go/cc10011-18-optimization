import { useMemo, useState } from 'react'

import { listEntries, runAction as applyAction } from '@/api/local-service'
import { saveStorageUi, saveStorageTarget, resumeRun, setFailureRecord, setQualityIssue, storageFieldRows, writeBack } from '@/api/reprocess-service'
import { useReprocess } from '@/api/use-reprocess'
import { MODULE_BY_KEY } from '@/data/modules'
import { costOf, diffVersions } from '@/data/reprocess-seed'
import type { EntryRow } from '@/data/types'
import { bizBadge, statusBadge, useFilteredStorageRows } from '@/views/shared/reprocess-ui'

const meta = MODULE_BY_KEY.get('storage')!

const STORAGE_STATUS = ['待写入', '已写入', '写入失败', '已跳过']

export default function StorageView() {
  const state = useReprocess()
  const ui = state.ui.storage
  const [configRows, setConfigRows] = useState<EntryRow[]>(() => listEntries(meta.key).items)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [draft, setDraft] = useState(state.storageTarget)

  const versionId = state.ui.extractor.versionId
  const baseVersionId = state.ui.extractor.baseVersionId
  const plan = state.plans[versionId]
  const run = plan ? state.runs[plan.runId] : undefined
  const verification = state.verifications[versionId]
  const decision = state.decisions[versionId]

  const rows = useMemo(() => storageFieldRows(versionId), [state, versionId])
  const filtered = useFilteredStorageRows(rows, ui)

  const diff = useMemo(() => {
    try {
      return diffVersions(state.versions, baseVersionId, versionId)
    } catch {
      return null
    }
  }, [state.versions, baseVersionId, versionId])
  const cost = diff ? costOf(diff.fields, state.records.length) : null

  const pending = rows.filter((row) => row.status === '待写入')
  const failed = rows.filter((row) => row.status === '写入失败')
  const touchedRecords = useMemo(() => {
    const ids = new Set(rows.filter((row) => row.status === '已写入' || row.status === '待写入').map((row) => row.recordId))
    return [...ids].sort()
  }, [rows])

  function report(text: string, ok: boolean) {
    setMessage({ text, ok })
  }

  function runWrite() {
    const result = writeBack(versionId)
    report(result.message, result.ok)
  }

  function runBatch() {
    const result = writeBack(versionId, 6)
    report(result.message, result.ok)
  }

  function runResume() {
    const result = resumeRun(versionId)
    report(result.message, result.ok)
  }

  function toggleFault(recordId: string) {
    const result = setFailureRecord(state.failureRecordId === recordId ? '' : recordId)
    report(result.message, result.ok)
  }

  function toggleQuality(recordId: string) {
    const result = setQualityIssue(state.qualityIssueRecordId === recordId ? '' : recordId)
    report(result.message, result.ok)
  }

  function saveConfig() {
    const result = saveStorageTarget(draft)
    report(result.message, result.ok)
  }

  function resultAction(action: string, row: EntryRow) {
    // 存储配置沿用通用状态流转；写回动作只围绕增量重算清单。
    const outcome = applyAction(meta.key, Number(row.id), action)
    setConfigRows(listEntries(meta.key).items)
    report(outcome.message, outcome.ok)
  }

  return (
    <section className="page" data-module="storage">
      <header className="page-head">
        <div>
          <h2>数据落盘管理</h2>
          <p className="page-desc">
            落盘链路：字段映射版本差异 → 字段映射增量重算清单 → 数据落盘按清单替换受影响目标字段，其他列继续引用上一版完整结果。
          </p>
        </div>
        <div className="page-actions">
          <span className="badge blue">
            当前数据集 {state.storageTarget.datasetName} · {state.storageTarget.outputPath}
          </span>
        </div>
      </header>

      <div className="stat-row">
        <article className="stat-card">
          <span className="stat-label">清单待写入</span>
          <strong className="stat-value">{pending.length}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">受影响记录</span>
          <strong className="stat-value">{plan?.affectedRecordIds.length ?? 0}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">本次替换目标字段</span>
          <strong className="stat-value">{plan?.changedFields.length ?? 0}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">完整版本</span>
          <strong className="stat-value mono" style={{ fontSize: 16 }}>{state.dataset.completeVersionId}</strong>
        </article>
      </div>

      <div className="tabs">
        <button className={`tab ${ui.tab === 'writeback' ? 'active' : ''}`} type="button" onClick={() => saveStorageUi({ tab: 'writeback' })}>
          写回队列
        </button>
        <button className={`tab ${ui.tab === 'config' ? 'active' : ''}`} type="button" onClick={() => saveStorageUi({ tab: 'config' })}>
          落盘配置
        </button>
      </div>

      {ui.tab === 'writeback' && (
        <>
          <div className="panel">
            <div className="panel-head">
              <div>
                <h3 className="panel-title">落盘前置核对</h3>
                <p className="panel-desc">
                  数据落盘只消费「按目标字段合并差异后重算」生成的清单。先核对差异、核验清单，再刷新落盘，避免拿未核验的清单写库。
                </p>
              </div>
              <span className={`badge ${verification ? 'green' : 'amber'}`}>
                {verification ? `清单已核验 ${verification.at}` : '清单未核验'}
              </span>
            </div>
            <div className="two-col">
              <div className="formula">
                <strong>差异来源</strong>
                <div>
                  {baseVersionId} → {versionId}；差异字段 {(diff?.fields ?? []).map((field) => field.targetField).join('、') || '无'}
                </div>
                <div className="hint">
                  未变化列：{(diff?.unchangedFields ?? []).join('、') || '无'}，落盘时继续引用 {state.dataset.completeVersionId} 的完整结果。
                </div>
              </div>
              <div className="formula">
                <strong>成本与恢复时间权衡</strong>
                <div>
                  按目标字段合并差异后重算：{cost?.fieldCells ?? 0} 个单元格 / {cost?.fieldMs ?? 0} ms；
                  按受影响记录整行重算：{cost?.rowCells ?? 0} 个单元格 / {cost?.rowMs ?? 0} ms。
                </div>
                <div className="hint">
                  字段级写入范围小、恢复快，但冲突字段与其同记录其他列可能出现口径不一致；整行重算口径统一但会覆盖未变化列，且人工修订列需复核。字段映射默认按字段级合并。
                </div>
              </div>
            </div>

            {decision && (
              <p className="hint" style={{ marginTop: 8 }}>
                冲突判定：{decision.targetFields.join('、')} 采用「{decision.strategy}」；复核依据：{decision.basis}
              </p>
            )}

            <div className="toolbar" style={{ marginTop: 10 }}>
              <button className="btn primary" type="button" onClick={runWrite} disabled={!plan}>
                按清单替换受影响目标字段
              </button>
              <button className="btn" type="button" onClick={runBatch} disabled={!plan || run?.status === '已完成'}>
                分批写入 6 条
              </button>
              <button className="btn" type="button" onClick={runResume} disabled={!plan || run?.status === '已完成'}>
                中断后立即恢复（从最后完整版本续做）
              </button>
              <span className="spacer" />
              <span className="hint">
                批次 {run?.runId ?? '—'} · 状态 <span className={statusBadge(run?.status ?? '待执行')}>{run?.status ?? '待执行'}</span> · 断点 {run?.checkpoint ?? 0}
              </span>
            </div>
            <div className="two-col" style={{ marginTop: 6 }}>
              <p className="hint">
                落盘故障注入：
                <select value={state.failureRecordId} onChange={(event) => toggleFault(event.target.value)}>
                  <option value="">不注入</option>
                  {touchedRecords.map((recordId) => (
                    <option key={recordId} value={recordId}>
                      {recordId} 落盘时中断
                    </option>
                  ))}
                </select>
                ；命中时整批回滚，不会只写一部分目标字段（仅影响写入与分批写入，「中断后立即恢复」不受影响）。
              </p>
              <p className="hint">
                数据质量演练：
                <select value={state.qualityIssueRecordId} onChange={(event) => toggleQuality(event.target.value)}>
                  <option value="">不开启</option>
                  {state.records.map((record) => (
                    <option key={record.recordId} value={record.recordId}>
                      {record.recordId} 源价格置空
                    </option>
                  ))}
                </select>
                ；必填目标字段被拦住时清单不落盘，需先修规则或源数据。
              </p>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <div>
                <h3 className="panel-title">字段映射增量重算清单（落盘视图）</h3>
                <p className="panel-desc">
                  待处理队列同步接收数据落盘回写状态；按目标字段 / 记录 / 状态检索，重进后仍能定位同一记录。
                </p>
              </div>
              <span className="hint">共 {rows.length} 条，筛选后 {filtered.length} 条</span>
            </div>
            <div className="toolbar">
              <label className="field-label">
                目标字段
                <input value={ui.targetField} placeholder="按目标字段检索" onChange={(event) => saveStorageUi({ targetField: event.target.value })} />
              </label>
              <label className="field-label">
                记录编号
                <input value={ui.recordId} placeholder="按记录编号检索" onChange={(event) => saveStorageUi({ recordId: event.target.value })} />
              </label>
              <label className="field-label">
                清单状态
                <select value={ui.status} onChange={(event) => saveStorageUi({ status: event.target.value })}>
                  <option value="">全部</option>
                  {STORAGE_STATUS.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </label>
              <span className="spacer" />
              <button className="btn ghost" type="button" onClick={() => saveStorageUi({ targetField: '', recordId: '', status: '' })}>
                重置条件
              </button>
            </div>
            {ui.focusRecordId && (
              <p className="hint">
                当前定位记录：<strong>{ui.focusRecordId}</strong>（
                {state.dataset.rows[ui.focusRecordId]?.bizStatus ?? '无记录'}）
              </p>
            )}
            <table className="mini-table">
              <thead>
                <tr>
                  <th>记录</th>
                  <th>目标字段</th>
                  <th>规则编号</th>
                  <th>上一版完整结果</th>
                  <th>本次重算结果</th>
                  <th>写入策略</th>
                  <th>清单状态</th>
                  <th>业务状态</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 200).map((row) => (
                  <tr
                    key={row.entryId}
                    className={`${row.recordId === ui.focusRecordId ? 'row-focus' : ''} clickable`}
                    onClick={() => saveStorageUi({ focusRecordId: row.recordId })}
                  >
                    <td className="mono nowrap">{row.recordId}</td>
                    <td className="nowrap">{row.targetField}</td>
                    <td className="mono">{row.ruleNo}</td>
                    <td className="hint">{row.oldValue || '（空）'}</td>
                    <td className={row.status === '已写入' ? 'ok-text' : ''}>{row.newValue || '（空）'}</td>
                    <td>
                      <span className={row.strategy === '整行' ? 'badge red' : 'badge blue'}>{row.strategy}</span>
                      {row.manual && <span className="badge amber">人工修订</span>}
                    </td>
                    <td><span className={statusBadge(row.status)}>{row.status}</span></td>
                    <td><span className={bizBadge(state.dataset.rows[row.recordId]?.bizStatus ?? '正常')}>{state.dataset.rows[row.recordId]?.bizStatus ?? '正常'}</span></td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={8} className="empty-state">
                      {plan ? '没有符合条件的清单记录' : '还没有增量重算清单，请先在字段映射页执行「按目标字段合并差异后重算」'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <div className="panel-head">
              <div>
                <h3 className="panel-title">受影响记录状态</h3>
                <p className="panel-desc">未变化目标字段保持上一版结果；受影响记录在清单中可定位，当日业务记录保留。</p>
              </div>
              <span className="hint">
                待复核 {state.records.filter((record) => state.dataset.rows[record.recordId]?.bizStatus === '待复核').length} 条 / 失败清单 {failed.length} 条
              </span>
            </div>
            <table className="mini-table">
              <thead>
                <tr>
                  <th>记录</th>
                  <th>业务日期</th>
                  <th>落到版本</th>
                  <th>人工修订列</th>
                  <th>业务状态</th>
                  <th>受影响目标字段</th>
                </tr>
              </thead>
              <tbody>
                {state.records.map((record) => {
                  const datasetRow = state.dataset.rows[record.recordId]
                  const affected = [...new Set(rows.filter((row) => row.recordId === record.recordId).map((row) => row.targetField))]
                  return (
                    <tr
                      key={record.recordId}
                      className={record.recordId === ui.focusRecordId ? 'row-focus' : ''}
                      onClick={() => saveStorageUi({ focusRecordId: record.recordId })}
                      style={{ cursor: 'pointer' }}
                    >
                      <td className="mono">{record.recordId}</td>
                      <td className="nowrap">{record.bizDate}</td>
                      <td className="mono">{datasetRow?.appliedVersionId ?? '—'}</td>
                      <td className="hint">{datasetRow?.manualEdits.join('、') || '—'}</td>
                      <td><span className={bizBadge(datasetRow?.bizStatus ?? '正常')}>{datasetRow?.bizStatus ?? '正常'}</span></td>
                      <td className="hint">{affected.join('、') || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {ui.tab === 'config' && (
        <div className="panel">
          <div className="panel-head">
            <div>
              <h3 className="panel-title">落盘配置</h3>
              <p className="panel-desc">存储配置沿用模块原有字段；落盘写回时按下面配置定位字段映射增量重算清单的更新点。</p>
            </div>
            <span className="badge">{meta.entity}</span>
          </div>
          <div className="toolbar">
            <label className="field-label">
              输出路径
              <input value={draft.outputPath} onChange={(event) => setDraft({ ...draft, outputPath: event.target.value })} />
            </label>
            <label className="field-label">
              数据集
              <input value={draft.datasetName} onChange={(event) => setDraft({ ...draft, datasetName: event.target.value })} />
            </label>
            <label className="field-label">
              覆写模式
              <select value={draft.writeMode} onChange={(event) => setDraft({ ...draft, writeMode: event.target.value })}>
                <option value="upsert">upsert</option>
                <option value="overwrite">overwrite</option>
                <option value="append">append</option>
              </select>
            </label>
            <button className="btn primary" type="button" onClick={saveConfig}>
              保存落盘配置
            </button>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                {meta.fields.map((field) => (
                  <th key={field}>{field}</th>
                ))}
                <th>当前状态</th>
                <th>可执行动作</th>
              </tr>
            </thead>
            <tbody>
              {configRows.map((row) => (
                <tr key={row.id}>
                  {meta.fields.map((field) => (
                    <td key={field}>{row[field] ?? '—'}</td>
                  ))}
                  <td>{row.status}</td>
                  <td className="row-actions">
                    {meta.actions.map((action) => (
                      <button key={action} className="link" type="button" onClick={() => resultAction(action, row)}>
                        {action}
                      </button>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <footer className="page-foot">
        <span>
          数据落盘按字段映射增量重算清单替换受影响目标字段；其他列继续引用 {state.dataset.completeVersionId} 的完整结果
        </span>
        {message && <span className={message.ok ? 'ok-text' : 'error-text'}>{message.text}</span>}
      </footer>
    </section>
  )
}
