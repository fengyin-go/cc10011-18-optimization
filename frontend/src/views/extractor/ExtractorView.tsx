import { useEffect, useMemo, useState } from 'react'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import { ensureExtractorRuleRows, saveExtractorUi } from '@/api/reprocess-service'
import { useReprocess } from '@/api/use-reprocess'
import { diffVersions, extractorRulesAsEntries } from '@/data/reprocess-seed'
import type { ExtractorUiState, MappingVersion } from '@/data/reprocess-types'
import type { EntryRow } from '@/data/types'

import LedgerPanel from './LedgerPanel'
import RecomputePanel from './RecomputePanel'
import RulesPanel from './RulesPanel'

const meta = moduleMeta('extractor')
const actions = ['提交校验', '启用规则', '停用规则']
const statuses = ['草稿', '待校验', '已启用', '已停用']

const EMPTY_FILTERS: Record<string, string> = {}

/** 规则行以版本规则为准做一次对齐，已有规则行的状态保留。 */
function alignedRows(version: MappingVersion): EntryRow[] {
  const stored = listEntries(meta.key).items
  const template = extractorRulesAsEntries(version, stored)
  return ensureExtractorRuleRows(template, version.rules.map((rule) => rule.ruleNo))
}

export default function ExtractorView() {
  const state = useReprocess()
  const ui = state.ui.extractor
  const { baseVersionId, versionId } = ui
  const tab = ui.tab
  const [rows, setRows] = useState<EntryRow[]>(() => alignedRows(state.versions.find((item) => item.versionId === versionId) ?? state.versions[0]))
  const [errorMessage, setErrorMessage] = useState('')
  const [okMessage, setOkMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>(EMPTY_FILTERS)

  const version = state.versions.find((item) => item.versionId === versionId) ?? state.versions[state.versions.length - 1]

  useEffect(() => {
    setRows(alignedRows(version))
    setFilters(EMPTY_FILTERS)
    // 只在切换版本时重置规则行与筛选条件
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionId])

  const rules = useMemo(() => extractorRulesAsEntries(version, rows), [version, rows])
  const filteredRules = useMemo(
    () =>
      rules.filter((row) =>
        Object.entries(filters).every(([field, value]) => value.trim() === '' || String(row[field] ?? '').includes(value.trim())),
      ),
    [rules, filters],
  )

  let diff: ReturnType<typeof diffVersions> | null = null
  let diffMessage = ''
  try {
    diff = diffVersions(state.versions, baseVersionId, versionId)
  } catch (error) {
    diffMessage = error instanceof Error ? error.message : '版本差异计算失败'
  }
  const diffFields = diff?.fields ?? []
  const plan = state.plans[versionId]
  const verifiedAt = state.verifications[versionId]?.at
  const pendingCount = plan?.entries.filter((item) => item.status === '待写入').length ?? 0
  const locked = (plan?.entries.some((item) => item.status === '已写入')) ?? false

  function result(message: string, ok: boolean) {
    setErrorMessage(ok ? '' : message)
    setOkMessage(ok ? message : '')
  }

  function runAction(action: string, row: EntryRow) {
    const id = Number(row.id)
    if (locked && versionId === state.dataset.completeVersionId) {
      result(`版本 ${versionId} 已落盘为完整版本，规则如需调整请先新增映射版本`, false)
      return
    }
    const outcome = applyAction(meta.key, id, action)
    if (!outcome.ok) {
      result(outcome.message, false)
      return
    }
    setRows(alignedRows(version))
    result(`${outcome.message}（规则 ${row['规则编号']} / 目标字段 ${row['目标字段名称']}）`, true)
  }

  return (
    <section className="page" data-module="extractor">
      <header className="page-head">
        <div>
          <h2>字段映射管理</h2>
          <p className="page-desc">
            维护字段映射规则的输入、执行约束与结果记录。字段映射、映射规则、规则编号共同构成主记录，映射规则经必填标识处理后写入字段映射增量重算清单。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出字段映射清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        <article className="stat-card">
          <span className="stat-label">映射规则总数</span>
          <strong className="stat-value">{version.rules.length}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">本次差异目标字段</span>
          <strong className="stat-value">{diffFields.length}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">受影响业务记录</span>
          <strong className="stat-value">{plan?.affectedRecordIds.length ?? 0}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">待替换目标字段</span>
          <strong className="stat-value">{pendingCount}</strong>
        </article>
      </div>

      <p className="status-legend">
        {state.versions.map((item) => (
          <span key={item.versionId} className="legend-item">
            {item.versionId} {item.status}：{item.rules.length} 条规则
          </span>
        ))}
        <span className="legend-item">上一版完整结果：{state.dataset.completeVersionId}</span>
        {diff && diff.conflictFields.length > 0 && (
          <span className="legend-item">冲突字段：{diff.conflictFields.join('、')}</span>
        )}
      </p>

      <div className="tabs">
        <button className={`tab ${tab === 'ledger' ? 'active' : ''}`} type="button" onClick={() => saveTab('ledger')}>
          增量重算清单
        </button>
        <button className={`tab ${tab === 'reprocess' ? 'active' : ''}`} type="button" onClick={() => saveTab('reprocess')}>
          差异与冲突判定
        </button>
        <button className={`tab ${tab === 'rules' ? 'active' : ''}`} type="button" onClick={() => saveTab('rules')}>
          映射规则
        </button>
      </div>

      {diffMessage && <p className="error-text">{diffMessage}</p>}

      {tab === 'rules' && (
        <RulesPanel
          versions={state.versions}
          version={version}
          statuses={statuses}
          actions={actions}
          rows={filteredRules}
          total={rules.length}
          filters={filters}
          onFilters={setFilters}
          onAction={runAction}
          onPickVersion={(next) => selectVersions(next, versionId)}
        />
      )}

      {tab === 'reprocess' && (
        <RecomputePanel
          state={state}
          versions={state.versions}
          baseVersionId={baseVersionId}
          versionId={versionId}
          planReady={Boolean(plan)}
          verifiedAt={verifiedAt}
          onPickVersions={selectVersions}
          onResult={result}
        />
      )}

      {tab === 'ledger' && (
        <LedgerPanel
          state={state}
          versionId={versionId}
          planReady={Boolean(plan)}
          unchangedFieldCount={diff?.unchangedFields.length ?? 0}
          diffFields={diffFields}
          onResult={result}
        />
      )}

      <div className="panel">
        <div className="panel-head">
          <div>
            <h3 className="panel-title">执行日志</h3>
            <p className="panel-desc">记录重算、核验、落盘与中断恢复；字段映射增量重算清单从最后完整版本续做。</p>
          </div>
          <span className="hint">
            待写入 {pendingCount} 条 / 已写入 {plan?.entries.filter((item) => item.status === '已写入').length ?? 0} 条
          </span>
        </div>
        <ul className="log-list">
          {state.logs.map((log) => (
            <li key={log.id} className={`log-item ${log.level}`}>
              <span className="log-time">{log.at}</span>
              {log.message}
            </li>
          ))}
        </ul>
      </div>

      <footer className="page-foot">
        <span>
          共 {rules.length} 条映射规则；当前版本 {versionId}，上一版完整结果 {state.dataset.completeVersionId}
        </span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
        {!errorMessage && okMessage && <span className="ok-text">{okMessage}</span>}
      </footer>
    </section>
  )

  function saveTab(next: ExtractorUiState['tab']) {
    saveExtractorUi({ tab: next })
  }

  function selectVersions(nextBase: string, nextVersion: string) {
    if (nextBase === nextVersion) {
      result('上一版与待重算版本不能是同一个映射版本', false)
      return
    }
    saveExtractorUi({ baseVersionId: nextBase, versionId: nextVersion })
  }
}
