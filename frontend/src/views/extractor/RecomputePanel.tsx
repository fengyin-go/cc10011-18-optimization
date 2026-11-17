import { useMemo, useState } from 'react'

import {
  adjudicateConflict,
  buildPlan,
  changeSummary,
  loadDiff,
  verifyPlan,
} from '@/api/reprocess-service'
import type { FieldDiff, MappingVersion, RecomputeStrategy, ReprocessState } from '@/data/reprocess-types'
import { costOf } from '@/data/reprocess-seed'

type Props = {
  state: ReprocessState
  versions: MappingVersion[]
  baseVersionId: string
  versionId: string
  planReady: boolean
  verifiedAt?: string
  onPickVersions: (baseVersionId: string, versionId: string) => void
  onResult: (message: string, ok: boolean) => void
}

const STRATEGY_ID = 'planner-strategy'
const BASIS_ID = 'planner-basis'

function StrategyExplain({ label, strategy }: { label: string; strategy: RecomputeStrategy }) {
  return (
    <div className="formula">
      <strong>{label}</strong>
      <div>
        {strategy === '字段级'
          ? '落库做法：只替换冲突目标字段，同记录其他列继续引用上一版完整结果；人工修订列不动，写入范围最小。'
          : '落库做法：命中记录整行重写，冲突字段与同记录其他列一并覆盖，人工修订列需复核；写入范围最大，可用于整体重算但对恢复时间不友好。'}
      </div>
    </div>
  )
}

export default function RecomputePanel({
  state,
  versions,
  baseVersionId,
  versionId,
  planReady,
  verifiedAt,
  onPickVersions,
  onResult,
}: Props) {
  const [strategy, setStrategy] = useState<RecomputeStrategy>(state.decisions[versionId]?.strategy ?? '字段级')
  const [basis, setBasis] = useState('')
  const diff = useMemo(() => loadDiff(baseVersionId, versionId), [baseVersionId, versionId])
  const plan = state.plans[versionId]
  const decision = state.decisions[versionId]
  const fields: FieldDiff[] = diff.ok && diff.data ? diff.data.fields : []
  const unchanged = diff.ok && diff.data ? diff.data.unchangedFields : []
  const conflicts = fields.filter((item) => item.conflict)
  const cost = useMemo(() => costOf(fields, state.records.length), [fields, state.records.length])
  const written = plan?.entries.filter((item) => item.status === '已写入').length ?? 0

  function runBuild(refresh: boolean) {
    if (refresh && !verifiedAt) {
      onResult('刷新前要先核验当前清单（按目标字段合并差异后重算 → 核验），避免带着未核对的结果刷新', false)
      return
    }
    const result = buildPlan(versionId, baseVersionId, strategy, refresh)
    onResult(result.message, result.ok)
  }

  function runVerify() {
    const result = verifyPlan(versionId)
    onResult(result.message, result.ok)
  }

  function runAdjudicate() {
    if (conflicts.length === 0) {
      onResult('本次差异没有同时改类型转换与清洗表达式的冲突字段', false)
      return
    }
    const result = adjudicateConflict(versionId, conflicts.map((item) => item.targetField), strategy, basis)
    onResult(result.message, result.ok)
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3 className="panel-title">按目标字段合并差异后重算</h3>
          <p className="panel-desc">
            读取新旧映射版本与上一版转换结果，只按目标字段差异重算映射记录；未变化列继续引用上一版完整结果（
            {state.dataset.completeVersionId}）。
          </p>
        </div>
        <span className={`badge ${verifiedAt ? 'green' : planReady ? 'blue' : 'gray'}`}>
          {verifiedAt ? `已核验 ${verifiedAt}` : planReady ? '清单已生成，待核验' : '未生成清单'}
        </span>
      </div>

      <div className="toolbar">
        <label className="field-label">
          上一版完整映射
          <select value={baseVersionId} onChange={(event) => onPickVersions(event.target.value, versionId)}>
            {versions
              .filter((item) => item.versionId !== versionId)
              .map((item) => (
                <option key={item.versionId} value={item.versionId}>
                  {item.versionId} · {item.label}
                </option>
              ))}
          </select>
        </label>
        <label className="field-label">
          待重算映射版本
          <select value={versionId} onChange={(event) => onPickVersions(baseVersionId, event.target.value)}>
            {versions.map((item) => (
              <option key={item.versionId} value={item.versionId}>
                {item.versionId} · {item.label}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        <button className="btn primary" type="button" onClick={() => runBuild(false)}>
          按目标字段合并差异后重算
        </button>
        <button className="btn" type="button" onClick={runVerify} disabled={!planReady}>
          核验清单
        </button>
        <button className="btn" type="button" onClick={() => runBuild(true)} disabled={!planReady}>
          刷新增量重算清单
        </button>
      </div>

      {!diff.ok && <p className="error-text">{diff.message}</p>}

      {diff.ok && diff.data && (
        <>
          <div className="two-col">
            <div>
              <p className="small-title">本次目标字段差异（{fields.length}）</p>
              <table className="mini-table">
                <thead>
                  <tr>
                    <th>目标字段</th>
                    <th>规则编号</th>
                    <th>变更类型</th>
                    <th>新旧规则</th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((field) => (
                    <tr key={field.targetField}>
                      <td className="nowrap">{field.targetField}</td>
                      <td className="mono">{field.ruleNo}</td>
                      <td>
                        <span className="badge amber">{changeSummary(field.changeTypes)}</span>
                        {field.conflict && <span className="badge red">写入范围冲突</span>}
                      </td>
                      <td className="hint">
                        {field.oldRule
                          ? `${field.oldRule.typeCast || 'string'} / ${field.oldRule.cleanseExpr || '无清洗'} / 默认 ${field.oldRule.defaultValue || '空'}`
                          : '上一版无此列'}
                        <br />→ {field.newRule
                          ? `${field.newRule.typeCast || 'string'} / ${field.newRule.cleanseExpr || '无清洗'} / 默认 ${field.newRule.defaultValue || '空'}`
                          : '本版删除'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="hint" style={{ marginTop: 8 }}>
                未变化目标字段（{unchanged.length}）：{unchanged.join('、')}，保持上一版完整结果。
              </p>
            </div>
            <div>
              <p className="small-title">成本与影响范围</p>
              <table className="mini-table">
                <thead>
                  <tr>
                    <th>口径</th>
                    <th>写入单元格</th>
                    <th>预估耗时</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>按目标字段合并差异后重算</td>
                    <td>{cost.fieldCells}</td>
                    <td>{cost.fieldMs} ms</td>
                  </tr>
                  <tr>
                    <td>按受影响记录整行重算</td>
                    <td>{cost.rowCells}</td>
                    <td>{cost.rowMs} ms</td>
                  </tr>
                </tbody>
              </table>
              <p className="hint" style={{ marginTop: 8 }}>
                {cost.fieldScope}；{cost.rowScope}。字段映射需在恢复时间与影响范围之间权衡，本次建议按字段级合并。
              </p>
            </div>
          </div>

          {conflicts.length > 0 && (
            <div className="formula" style={{ marginTop: 12 }}>
              <p className="small-title">冲突判定：{conflicts.map((item) => item.targetField).join('、')}</p>
              <p className="hint">
                同一目标字段同时发生类型转换与清洗表达式变化，字段级与记录级整行重算会形成不同的目标结果写入范围。请判定本次落库做法。
              </p>
              <div className="two-col" style={{ marginTop: 8 }}>
                <StrategyExplain label="方案 A · 按目标字段合并差异后重算" strategy="字段级" />
                <StrategyExplain label="方案 B · 按受影响记录整行重算" strategy="整行" />
              </div>
              <div className="toolbar" style={{ marginTop: 8 }}>
                <label className="field-label">
                  落库策略
                  <select id={STRATEGY_ID} value={strategy} onChange={(event) => setStrategy(event.target.value as RecomputeStrategy)}>
                    <option value="字段级">按目标字段合并差异后重算（字段级）</option>
                    <option value="整行">按受影响记录整行重算（记录级）</option>
                  </select>
                </label>
                <label className="field-label" style={{ flex: 1, minWidth: 260 }}>
                  复核依据（可留空用默认口径）
                  <input
                    id={BASIS_ID}
                    value={basis}
                    placeholder="例如：销售价需同时换类型与清洗，复算后只替换销售价列"
                    onChange={(event) => setBasis(event.target.value)}
                  />
                </label>
                <button className="btn" type="button" onClick={runAdjudicate}>
                  记录冲突判定
                </button>
              </div>
              {decision && (
                <p className="hint">
                  已判定：{decision.targetFields.join('、')} 采用「{decision.strategy}」；依据：{decision.basis}（{decision.decidedAt}）
                </p>
              )}
            </div>
          )}

          {plan && (
            <p className="hint" style={{ marginTop: 10 }}>
              当前清单：批次 {plan.runId}（{state.runs[plan.runId]?.status ?? '待执行'}），受影响记录 {plan.affectedRecordIds.length} 条，
              已写入 {written} / 待写入 {plan.entries.filter((item) => item.status === '待写入').length}。
              同一映射版本重复执行会复用本清单，不会再次列出一批相同记录。
            </p>
          )}
        </>
      )}
    </div>
  )
}

export { STRATEGY_ID, BASIS_ID }
