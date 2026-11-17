import type {
  ConflictDecision,
  DatasetRow,
  DiffResult,
  FieldDiff,
  ManifestEntry,
  MappingRule,
  Plan,
  RecomputeStrategy,
  RecordWorkbenchRow,
  ReprocessLog,
  ReprocessResult,
  ReprocessRun,
  ReprocessState,
  RuleChangeType,
} from '@/data/reprocess-types'
import {
  allBusinessFields,
  applyRule,
  costOf,
  diffVersions,
  newId,
  nowStamp,
  recordSummary,
} from '@/data/reprocess-seed'
import { commitReprocess, reprocessState } from '@/data/reprocess-store'
import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function addLog(state: ReprocessState, level: ReprocessLog['level'], message: string): void {
  state.logs = [
    { id: newId('LOG', state.logs.map((item) => item.id)), at: nowStamp(), level, message },
    ...state.logs,
  ].slice(0, 60)
}

/** 读快照 → 修改 → 原子落盘；落盘失败则内存不生效。 */
function persist(state: ReprocessState): ReprocessResult {
  if (!commitReprocess(state)) {
    return { ok: false, message: '本地存储写入失败，本次改动未生效，数据仍停留在上一次完整状态' }
  }
  return { ok: true, message: '已保存' }
}

function currentPlan(versionId: string): Plan | undefined {
  return reprocessState().plans[versionId]
}

export function loadDiff(baseVersionId: string, versionId: string): ReprocessResult<DiffResult> {
  try {
    const state = reprocessState()
    return { ok: true, message: '差异已计算', data: diffVersions(state.versions, baseVersionId, versionId) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '版本差异计算失败' }
  }
}

export function existingPlan(versionId: string): Plan | null {
  return currentPlan(versionId) ?? null
}

/** 判定冲突列在两种策略下的落库做法，并把复核依据固化下来。 */
export function adjudicateConflict(
  versionId: string,
  targetFields: string[],
  strategy: RecomputeStrategy,
  basis: string,
): ReprocessResult<ConflictDecision> {
  const state = clone(reprocessState())
  const plan = state.plans[versionId]
  if (!plan) {
    return { ok: false, message: '还没有生成增量重算清单，先执行「按目标字段合并差异后重算」' }
  }
  const diff = diffVersions(state.versions, plan.baseVersionId, plan.versionId)
  const fields = diff.fields.filter((item) => targetFields.includes(item.targetField))
  if (fields.length === 0) {
    return { ok: false, message: '所选目标字段不在本次差异范围内' }
  }
  const nonConflict = fields.filter((item) => !item.conflict)
  const decision: ConflictDecision = {
    versionId,
    baseVersionId: plan.baseVersionId,
    targetFields: fields.map((item) => item.targetField),
    strategy,
    basis: basis.trim() === ''
      ? (strategy === '字段级'
        ? '按目标字段合并差异后重算：只替换冲突字段，其他列继续引用上一版完整结果'
        : '按受影响记录整行重算：冲突字段与同记录其他列一起重写，写入范围更大，人工修订列需复核')
      : basis.trim(),
    decidedAt: nowStamp(),
    cost: costOf(diff.fields, state.records.length),
  }
  state.decisions[versionId] = decision
  if (plan.entries.some((item) => item.status === '已写入')) {
    addLog(state, 'warn', `冲突判定已记录，但 ${versionId} 已有目标字段写入，需刷新增量重算清单后才会按「${strategy}」调整写入范围。`)
  } else {
    plan.strategy = strategy
    for (const entry of plan.entries) {
      if (fields.some((item) => item.targetField === entry.targetField)) {
        entry.strategy = strategy
      }
    }
    state.runs[plan.runId] && (state.runs[plan.runId].strategy = strategy)
  }
  addLog(
    state,
    'warn',
    `冲突判定：${decision.targetFields.join('、')} 采用「${strategy}」落库${nonConflict.length ? `（${nonConflict.map((item) => item.targetField).join('、')} 并非冲突字段，仍按字段级处理）` : ''}；复核依据已记录。`,
  )
  const result = persist(state)
  return {
    ok: result.ok,
    message: result.ok ? `已记录冲突判定：${decision.targetFields.join('、')} 采用「${decision.strategy}」落库` : result.message,
    data: decision,
  }
}

/**
 * 按目标字段合并差异后重算：
 * 清单生成即完成映射重算（新值只进清单，不碰数据落盘），同一版本重复执行复用原清单。
 */
export function buildPlan(
  versionId: string,
  baseVersionId: string,
  strategy: RecomputeStrategy,
  refresh = false,
): ReprocessResult<Plan> {
  const state = clone(reprocessState())
  let diff: DiffResult
  try {
    diff = diffVersions(state.versions, baseVersionId, versionId)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '版本差异计算失败' }
  }
  if (diff.fields.length === 0) {
    return { ok: false, message: `${versionId} 相对 ${baseVersionId} 没有目标字段差异，不需要重算` }
  }

  const previous = state.plans[versionId]
  if (previous && previous.entries.some((item) => item.status === '已写入')) {
    return {
      ok: false,
      message: `${versionId} 的清单已有目标字段写入数据落盘，不能重建；如需重做请从执行日志恢复或重置模块`,
      data: previous,
    }
  }
  if (previous && !refresh) {
    // 同一映射版本重复执行：直接复用，不再列出一批相同记录。
    return {
      ok: true,
      message: `同一版本 ${versionId} 已有增量重算清单（${previous.affectedRecordIds.length} 条受影响记录 / ${previous.changedFields.length} 个目标字段），未重复生成`,
      data: previous,
    }
  }

  const runId = previous?.runId ?? newId('RUN', Object.keys(state.runs))
  const previousByKey = new Map((previous?.entries ?? []).map((item) => [`${item.recordId}::${item.targetField}`, item]))
  const decided = state.decisions[versionId]
  const effectiveStrategy = decided?.strategy ?? strategy

  const entries: ManifestEntry[] = []
  let manualPreserved = 0
  for (const record of state.records) {
    const datasetRow = state.dataset.rows[record.recordId]
    for (const field of diff.fields) {
      const key = `${record.recordId}::${field.targetField}`
      const reuse = previousByKey.get(key)
      const isConflict = field.conflict
      const entryStrategy: RecomputeStrategy = isConflict ? effectiveStrategy : '字段级'
      const manual = datasetRow?.manualEdits.includes(field.targetField) ?? false
      const oldValue = datasetRow?.values[field.targetField] ?? ''
      let newValue = oldValue
      let error = ''
      let status: ManifestEntry['status'] = '待写入'
      let calcFailed = false
      if (manual) {
        status = '已跳过'
        newValue = oldValue
        manualPreserved += 1
      } else {
        // 数据质量演练：把该记录的价格源值置空，必填字段在映射阶段就会被拦住。
        const source =
          state.qualityIssueRecordId === record.recordId ? { ...record.raw, price: '' } : record.raw
        try {
          newValue = field.newRule ? applyRule(source, field.newRule) : ''
        } catch (caught) {
          error = caught instanceof Error ? caught.message : '映射计算失败'
          newValue = ''
        }
        if (error) {
          status = '写入失败'
          calcFailed = true
        }
        else if (newValue === oldValue) status = '已跳过'
      }
      const message = manual
        ? '该列含人工修订，按上一版完整结果保留，需人工复核'
        : error ||
          (status === '已跳过' ? (field.changeTypes.length > 0 ? '重算结果与上一版一致，无需替换' : '无差异') : undefined)
      entries.push({
        id: reuse?.id && previous ? reuse.id : `${runId}-${record.recordId}-${field.targetField}`,
        versionId,
        baseVersionId,
        recordId: record.recordId,
        bizDate: record.bizDate,
        ruleNo: field.newRule?.ruleNo ?? field.oldRule?.ruleNo ?? '',
        targetField: field.targetField,
        changeTypes: [...field.changeTypes] as RuleChangeType[],
        oldValue,
        newValue,
        changed: !manual && !error && newValue !== oldValue,
        required: field.newRule?.required ?? false,
        uniqueCheck: field.newRule?.uniqueCheck ?? false,
        strategy: entryStrategy,
        status,
        calcFailed,
        message,
        updatedAt: nowStamp(),
      })
    }
  }

  const affectedRecordIds = [
    ...new Set(
      entries
        .filter((item) => item.changed || (state.dataset.rows[item.recordId]?.manualEdits.includes(item.targetField) ?? false))
        .map((item) => item.recordId),
    ),
  ]
  const verification = state.verifications[versionId]
  const plan: Plan = {
    versionId,
    baseVersionId,
    strategy: effectiveStrategy,
    runId,
    createdAt: previous?.createdAt ?? nowStamp(),
    verifiedAt: refresh ? undefined : verification?.at,
    changedFields: diff.fields.map((item) => item.targetField),
    conflictFields: [...diff.conflictFields],
    affectedRecordIds,
    entries,
    inputIssueRecordId: state.qualityIssueRecordId,
  }
  state.plans[versionId] = plan
  if (refresh) {
    delete state.verifications[versionId]
  }

  const oldRun = state.runs[runId]
  const run: ReprocessRun = {
    runId,
    versionId,
    baseVersionId,
    strategy: effectiveStrategy,
    status: oldRun?.status ?? '待执行',
    totalEntries: entries.length,
    totalRecords: affectedRecordIds.length,
    writtenEntries: entries.filter((item) => item.status === '已写入').length,
    writtenRecords: new Set(entries.filter((item) => item.status === '已写入').map((item) => item.recordId)).size,
    checkpoint: oldRun?.checkpoint ?? 0,
    startedAt: oldRun?.startedAt ?? nowStamp(),
    updatedAt: nowStamp(),
    lastError: oldRun?.lastError,
  }
  state.runs[runId] = run

  const strategyDesc = decided ? `冲突字段按已判定的「${decided.strategy}」落库` : '全部按字段级替换'
  addLog(
    state,
    'info',
    `${refresh ? '刷新' : '生成'}增量重算清单：${versionId} 对 ${baseVersionId}，差异字段 ${diff.fields.length} 个（${diff.fields.map((item) => item.targetField).join('、')}），受影响记录 ${affectedRecordIds.length} 条，${strategyDesc}${manualPreserved ? `，人工修订列 ${manualPreserved} 处保留原结果` : ''}。`,
  )
  const result = persist(state)
  return {
    ok: result.ok,
    message: result.ok
      ? `已${refresh ? '刷新' : '生成'} ${versionId} 的字段映射增量重算清单：${affectedRecordIds.length} 条受影响记录 / ${diff.fields.length} 个目标字段`
      : result.message,
    data: plan,
  }
}

export function verifyPlan(versionId: string): ReprocessResult<Plan> {
  const state = clone(reprocessState())
  const plan = state.plans[versionId]
  if (!plan) {
    return { ok: false, message: '还没有重算清单，先按目标字段合并差异后重算' }
  }
  if ((plan.inputIssueRecordId ?? '') !== state.qualityIssueRecordId) {
    return {
      ok: false,
      message: `数据质量演练参数已变更（当前 ${state.qualityIssueRecordId || '未开启'}），清单需先刷新增量重算后重新核验`,
    }
  }
  const diff = diffVersions(state.versions, plan.baseVersionId, plan.versionId)
  const problems: string[] = []
  for (const entry of plan.entries) {
    if (entry.calcFailed) {
      problems.push(`${entry.recordId}/${entry.targetField} 映射计算失败（${entry.message ?? '必填或清洗异常'}）`)
    }
    if ((entry.status === '待写入' || entry.status === '写入失败') && entry.newValue === '') {
      problems.push(`${entry.recordId}/${entry.targetField} 待写入值为空`)
    }
    if (entry.newValue === '' && entry.required && entry.status !== '已跳过') {
      problems.push(`${entry.recordId}/${entry.targetField} 必填为空`)
    }
  }
  if (diff.unchangedFields.length === 0) {
    problems.push('没有未变化的列可供核对')
  }
  const untouched = diff.unchangedFields.every((field) =>
    state.records.every((record) => state.dataset.lastCompleteValues[record.recordId]?.[field] !== undefined),
  )
  if (!untouched) {
    problems.push('上一版完整结果缺少未变化列的引用值')
  }
  if (problems.length > 0) {
    addLog(state, 'error', `增量重算清单核验未通过：${problems.slice(0, 4).join('；')}${problems.length > 4 ? ' 等' : ''}`)
    persist(state)
    return { ok: false, message: `核验未通过：${problems.slice(0, 3).join('；')}` }
  }
  const pendingWrites = plan.entries.filter((item) => item.status === '待写入').length
  state.verifications[versionId] = {
    versionId,
    baseVersionId: plan.baseVersionId,
    at: nowStamp(),
    strategy: plan.strategy,
    note: `未变化目标字段 ${diff.unchangedFields.join('、')} 继续引用上一版完整结果（${plan.baseVersionId}）；${pendingWrites} 个目标字段待替换，受影响记录可在清单中按目标字段定位。`,
  }
  plan.verifiedAt = state.verifications[versionId].at
  addLog(
    state,
    'success',
    `增量重算清单核验通过：${versionId}，冲突字段判定「${plan.strategy}」，未变化列 ${diff.unchangedFields.join('、')} 保持上一版结果。`,
  )
  const result = persist(state)
  return { ok: result.ok, message: result.ok ? '核验通过：未变化目标字段保持原结果，受影响记录可按目标字段定位' : result.message, data: plan }
}

export type WritebackResult = {
  writtenEntries: number
  writtenRecords: number
  interrupted: boolean
  failedRecordId: string
}

/**
 * 数据落盘：按清单替换受影响目标字段，整批一次提交。
 * 任一条失败则整批回滚（内存与 localStorage 都不变），不会只写一部分目标字段。
 */
export function writeBack(versionId: string, limit?: number): ReprocessResult<WritebackResult> {
  const state = clone(reprocessState())
  const plan = state.plans[versionId]
  if (!plan) {
    return { ok: false, message: '还没有增量重算清单，先执行按目标字段合并差异后重算' }
  }
  if (state.dataset.completeVersionId === versionId) {
    return { ok: false, message: `${versionId} 已经完整落盘，未变化目标字段继续引用该版本结果，无需重复写入` }
  }
  const calcFailedEntries = plan.entries.filter((item) => item.calcFailed)
  if (calcFailedEntries.length > 0) {
    return {
      ok: false,
      message: `清单中有 ${calcFailedEntries.length} 条映射计算失败的记录（如 ${calcFailedEntries
        .slice(0, 3)
        .map((item) => `${item.recordId}/${item.targetField}`)
        .join('、')}），需先修复映射规则或源数据，本批未写入`,
    }
  }
  if (!state.verifications[versionId]) {
    return { ok: false, message: '清单尚未核验：先按目标字段合并差异后重算，再核验清单，核验通过后才允许刷新落盘' }
  }
  if (plan.entries.some((item) => item.changeTypes.includes('新增规则'))) {
    return { ok: false, message: '本批包含新增目标字段，现有表结构没有该列，请先确认按记录级整行重算的写入范围再落盘' }
  }
  const run = state.runs[plan.runId]
  if (!run) {
    return { ok: false, message: '找不到本次重算批次，先刷新增量重算清单' }
  }

  // 写入失败的清单记录仍算待替换：重试时一并补齐，避免失败记录被静默漏写。
  const pending = plan.entries.filter((item) => item.status === '待写入' || (item.status === '写入失败' && !item.calcFailed))
  if (pending.length === 0) {
    return { ok: false, message: `${versionId} 没有待替换的目标字段（可能已全部写入或结果未变化）` }
  }
  const batch = pending.slice(0, limit && limit > 0 ? limit : pending.length)
  const touched = new Set(batch.map((item) => item.recordId))

  // 故障注入：用于核对「整批失败不半写」。
  const fault = state.failureRecordId
    ? batch.find((item) => item.recordId === state.failureRecordId)
    : undefined
  if (fault) {
    const target = plan.entries.find((item) => item.id === fault.id)
    if (target) {
      target.status = '写入失败'
      target.message = `目标记录 ${fault.recordId} 落盘失败（故障注入）`
      target.updatedAt = nowStamp()
    }
    run.status = '已中断'
    run.lastError = `目标记录 ${fault.recordId} 落盘失败（故障注入），整批已回滚`
    run.checkpoint = plan.entries.filter((item) => item.status === '已写入').length
    run.updatedAt = nowStamp()
    addLog(
      state,
      'error',
      `数据落盘中断：命中故障记录 ${fault.recordId}，本批 ${batch.length} 条清单记录全部回滚（未写入任何目标字段），可从最后完整版本 ${state.dataset.completeVersionId} 续做。`,
    )
    persist(state)
    return {
      ok: false,
      message: `落盘中断：${fault.recordId} 写入失败，本批 ${batch.length} 条目标字段均未提交，可从 ${state.dataset.completeVersionId} 续做`,
      data: { writtenEntries: 0, writtenRecords: 0, interrupted: true, failedRecordId: fault.recordId },
    }
  }

  // 先在副本上合并整批结果，全部成功才回写到状态。
  const staged: Record<string, DatasetRow> = {}
  for (const recordId of touched) {
    const rowData = state.dataset.rows[recordId]
    if (!rowData) {
      return { ok: false, message: `业务记录 ${recordId} 在数据集中不存在，本批未写入` }
    }
    staged[recordId] = clone(rowData)
  }
  for (const recordId of touched) {
    // 按受影响记录整行重算：命中的记录整行重跑当前版本规则，再叠加本批字段级结果。
    // 整行重写会覆盖未变化列，因此不做静默覆盖，业务状态置为待复核。
    const rowStrategy = batch.some((item) => item.recordId === recordId && item.strategy === '整行')
    if (!rowStrategy) continue
    const record = state.records.find((item) => item.recordId === recordId)
    if (!record) continue
    const versionRules = state.versions.find((item) => item.versionId === versionId)?.rules ?? []
    const wholeRow: Record<string, string> = {}
    for (const rule of versionRules) {
      if (staged[recordId].manualEdits.includes(rule.targetField)) continue
      try {
        wholeRow[rule.targetField] = applyRule(record.raw, rule)
      } catch {
        wholeRow[rule.targetField] = staged[recordId].values[rule.targetField] ?? ''
      }
    }
    staged[recordId].values = { ...staged[recordId].values, ...wholeRow }
  }
  for (const entry of batch) {
    staged[entry.recordId].values[entry.targetField] = entry.newValue
  }
  for (const recordId of touched) {
    const rowData = staged[recordId]
    rowData.appliedVersionId = versionId
    rowData.updatedAt = nowStamp()
    if (rowData.bizStatus !== '异常') rowData.bizStatus = '待复核'
  }

  for (const recordId of touched) {
    state.dataset.rows[recordId] = staged[recordId]
  }
  for (const entry of batch) {
    const target = plan.entries.find((item) => item.id === entry.id)
    if (target) {
      target.status = '已写入'
      target.updatedAt = nowStamp()
      if (target.message === undefined) target.message = ''
    }
  }

  const remaining = plan.entries.filter((item) => item.status === '待写入' || item.status === '写入失败').length
  run.writtenEntries = plan.entries.filter((item) => item.status === '已写入').length
  run.writtenRecords = new Set(plan.entries.filter((item) => item.status === '已写入').map((item) => item.recordId)).size
  run.checkpoint = run.writtenEntries
  run.updatedAt = nowStamp()

  if (remaining === 0) {
    completeVersion(state, plan)
    addLog(
      state,
      'success',
      `数据落盘完成：${versionId} 替换 ${plan.changedFields.length} 个目标字段（${plan.changedFields.join('、')}），覆盖 ${run.writtenRecords} 条受影响记录；其他列继续引用 ${plan.baseVersionId} 的完整结果，当日业务记录已保留。`,
    )
  } else {
    run.status = '部分回写'
    addLog(
      state,
      'warn',
      `数据落盘分批写入：本批提交 ${batch.length} 条清单记录，剩余 ${remaining} 条待继续；只有全部清单记录写入后才标记完整版本。`,
    )
  }

  const result = persist(state)
  if (!result.ok) {
    return { ok: false, message: result.message }
  }
  return {
    ok: true,
    message: remaining === 0
      ? `${versionId} 已完整落盘：更新 ${run.writtenRecords} 条记录 / ${plan.changedFields.length} 个目标字段`
      : `已写入 ${batch.length} 条清单记录，剩余 ${remaining} 条可继续`,
    data: { writtenEntries: batch.length, writtenRecords: touched.size, interrupted: false, failedRecordId: '' },
  }
}

function completeVersion(state: ReprocessState, plan: Plan): void {
  const versionId = plan.versionId
  state.dataset.completeVersionId = versionId
  state.dataset.lastCompleteValues = Object.fromEntries(
    Object.entries(state.dataset.rows).map(([recordId, value]) => [recordId, { ...value.values }]),
  )
  state.dataset.updatedAt = nowStamp()
  const run = state.runs[plan.runId]
  if (run) run.status = '已完成'
  const version = state.versions.find((item) => item.versionId === versionId)
  if (version) version.status = '完整版本'
  const base = state.versions.find((item) => item.versionId === plan.baseVersionId)
  if (base) base.status = '历史版本'
}

/** 字段映射中断后立即恢复：从最后完整版本续做剩余清单记录。 */
export function resumeRun(versionId: string): ReprocessResult<WritebackResult> {
  const state = clone(reprocessState())
  const plan = state.plans[versionId]
  const run = plan ? state.runs[plan.runId] : undefined
  if (!plan || !run) {
    return { ok: false, message: '没有可恢复的重算批次' }
  }
  if (state.dataset.completeVersionId === versionId) {
    return { ok: false, message: `${versionId} 已经完整落盘，无需恢复` }
  }
  if (plan.entries.some((item) => item.changeTypes.includes('新增规则'))) {
    return { ok: false, message: '本批包含新增目标字段，不能按字段级续做' }
  }
  const calcFailedEntries = plan.entries.filter((item) => item.calcFailed)
  if (calcFailedEntries.length > 0) {
    return {
      ok: false,
      message: `清单中有 ${calcFailedEntries.length} 条映射计算失败的记录，需先修复映射规则或源数据，暂不能续做`,
    }
  }
  const resumeFrom = plan.entries.filter((item) => item.status === '待写入' || (item.status === '写入失败' && !item.calcFailed))
  if (resumeFrom.length === 0) {
    return { ok: false, message: '没有待续做的清单记录' }
  }
  run.status = '执行中'
  run.updatedAt = nowStamp()

  const staged: Record<string, DatasetRow> = {}
  for (const recordId of new Set(resumeFrom.map((item) => item.recordId))) {
    const rowData = state.dataset.rows[recordId]
    if (!rowData) {
      return { ok: false, message: `业务记录 ${recordId} 在数据集中不存在，续做未写入` }
    }
    staged[recordId] = clone(rowData)
  }
  // 续做沿用清单里已判定的写入范围：整行策略的记录也整行重算，不能只补字段。
  for (const entry of resumeFrom) {
    if (entry.strategy !== '整行') continue
    const record = state.records.find((item) => item.recordId === entry.recordId)
    if (!record) continue
    const versionRules = state.versions.find((item) => item.versionId === versionId)?.rules ?? []
    for (const rule of versionRules) {
      if (staged[entry.recordId].manualEdits.includes(rule.targetField)) continue
      try {
        staged[entry.recordId].values[rule.targetField] = applyRule(record.raw, rule)
      } catch {
        /* 保留原值，交由清单说明 */
      }
    }
  }
  for (const entry of resumeFrom) {
    staged[entry.recordId].values[entry.targetField] = entry.newValue
    staged[entry.recordId].appliedVersionId = versionId
    staged[entry.recordId].updatedAt = nowStamp()
    if (staged[entry.recordId].bizStatus !== '异常') staged[entry.recordId].bizStatus = '待复核'
  }
  for (const recordId of Object.keys(staged)) {
    state.dataset.rows[recordId] = staged[recordId]
  }
  for (const entry of resumeFrom) {
    const target = plan.entries.find((item) => item.id === entry.id)
    if (target) {
      target.status = '已写入'
      target.message = ''
      target.updatedAt = nowStamp()
    }
  }
  run.writtenEntries = plan.entries.filter((item) => item.status === '已写入').length
  run.writtenRecords = new Set(plan.entries.filter((item) => item.status === '已写入').map((item) => item.recordId)).size
  run.checkpoint = run.writtenEntries
  run.updatedAt = nowStamp()
  run.lastError = undefined
  completeVersion(state, plan)
  addLog(
    state,
    'success',
    `已从最后完整版本 ${plan.baseVersionId} 续做：补齐 ${resumeFrom.length} 条清单记录 / ${Object.keys(staged).length} 条记录，${versionId} 形成新的完整版本，当日业务记录保留。`,
  )
  const result = persist(state)
  return {
    ok: result.ok,
    message: result.ok ? `续做完成：补齐 ${resumeFrom.length} 条清单记录，${versionId} 已完整落盘` : result.message,
    data: { writtenEntries: resumeFrom.length, writtenRecords: Object.keys(staged).length, interrupted: false, failedRecordId: '' },
  }
}

/** 人工复核：数据工程师重算完成后，字段映射用户核对业务状态。 */
export function reviewRecord(recordId: string, status: '已复核' | '异常'): ReprocessResult {
  const state = clone(reprocessState())
  const rowData = state.dataset.rows[recordId]
  if (!rowData) {
    return { ok: false, message: `没有找到业务记录 ${recordId}` }
  }
  rowData.bizStatus = status
  rowData.updatedAt = nowStamp()
  addLog(state, status === '已复核' ? 'success' : 'warn', `记录 ${recordId} 已标记为「${status}」`)
  const result = persist(state)
  return { ok: result.ok, message: result.ok ? `记录 ${recordId} 已标记为「${status}」` : result.message }
}

export function setQualityIssue(recordId: string): ReprocessResult {
  const state = clone(reprocessState())
  state.qualityIssueRecordId = recordId
  // 演练改变了重算输入：清单保留待查，但核验作废，须刷新后重新核验才能落盘。
  state.verifications = {}
  addLog(
    state,
    recordId ? 'warn' : 'info',
    recordId
      ? `已开启数据质量演练：${recordId} 的源价格置空，必填目标字段「销售价」应在重算时被拦住`
      : '已关闭数据质量演练',
  )
  return persist(state)
}

export function setFailureRecord(recordId: string): ReprocessResult {
  const state = clone(reprocessState())
  state.failureRecordId = recordId
  addLog(
    state,
    recordId ? 'warn' : 'info',
    recordId ? `已注入落盘故障：命中 ${recordId} 时整批回滚` : '已清除落盘故障注入',
  )
  return persist(state)
}

export function saveExtractorUi(patch: Partial<ReprocessState['ui']['extractor']>): void {
  const state = clone(reprocessState())
  state.ui.extractor = { ...state.ui.extractor, ...patch }
  persist(state)
}

export function saveExtractorSearch(patch: Partial<ReprocessState['ui']['extractor']['search']>): void {
  const state = clone(reprocessState())
  state.ui.extractor = { ...state.ui.extractor, search: { ...state.ui.extractor.search, ...patch } }
  persist(state)
}

export function saveStorageUi(patch: Partial<ReprocessState['ui']['storage']>): void {
  const state = clone(reprocessState())
  state.ui.storage = { ...state.ui.storage, ...patch }
  persist(state)
}

export function saveStorageTarget(patch: Partial<ReprocessState['storageTarget']>): ReprocessResult {
  const state = clone(reprocessState())
  state.storageTarget = { ...state.storageTarget, ...patch }
  addLog(
    state,
    'info',
    `数据落盘配置更新：${state.storageTarget.outputPath}/${state.storageTarget.datasetName}（${state.storageTarget.writeMode}）`,
  )
  return persist(state)
}

export type StorageFieldRow = {
  entryId: string
  recordId: string
  bizDate: string
  targetField: string
  ruleNo: string
  oldValue: string
  newValue: string
  status: string
  strategy: RecomputeStrategy
  manual: boolean
}

/** 数据落盘页的字段级清单行：按目标字段/记录/状态筛选。 */
export function storageFieldRows(versionId: string): StorageFieldRow[] {
  const state = reprocessState()
  const plan = state.plans[versionId]
  if (!plan) return []
  const records = new Map(state.records.map((item) => [item.recordId, item]))
  return plan.entries.map((entry) => ({
    entryId: entry.id,
    recordId: entry.recordId,
    bizDate: records.get(entry.recordId)?.bizDate ?? '',
    targetField: entry.targetField,
    ruleNo: entry.ruleNo,
    oldValue: entry.oldValue,
    newValue: entry.newValue,
    status: entry.status,
    strategy: entry.strategy,
    manual: state.dataset.rows[entry.recordId]?.manualEdits.includes(entry.targetField) ?? false,
  }))
}

export function recordWorkbench(versionId: string): RecordWorkbenchRow[] {
  const state = reprocessState()
  return state.records
    .map((record) => recordSummary(state, versionId, record.recordId))
    .filter((item): item is RecordWorkbenchRow => item !== null)
}

export function datasetColumns(): string[] {
  return allBusinessFields()
}

export function affectedFieldOptions(): string[] {
  const state = reprocessState()
  const { baseVersionId, versionId } = state.ui.extractor
  const plan = state.plans[versionId]
  if (plan) return plan.changedFields
  try {
    return diffVersions(state.versions, baseVersionId, versionId).fields.map((item) => item.targetField)
  } catch {
    return []
  }
}

export function currentVersionPair(): { baseVersionId: string; versionId: string } {
  const state = reprocessState()
  return { baseVersionId: state.ui.extractor.baseVersionId, versionId: state.ui.extractor.versionId }
}

export function ruleOf(versionId: string, targetField: string): MappingRule | undefined {
  const version = reprocessState().versions.find((item) => item.versionId === versionId)
  return version?.rules.find((item) => item.targetField === targetField)
}

export function fieldDiffOf(baseVersionId: string, versionId: string, targetField: string): FieldDiff | undefined {
  try {
    return diffVersions(reprocessState().versions, baseVersionId, versionId).fields.find((item) => item.targetField === targetField)
  } catch {
    return undefined
  }
}

export function changeSummary(changeTypes: RuleChangeType[]): string {
  return changeTypes.length > 0 ? changeTypes.join(' + ') : '无变化'
}

export function affectedRecordCount(versionId: string): number {
  return reprocessState().plans[versionId]?.affectedRecordIds.length ?? 0
}

/**
 * 映射规则行与版本规则对齐：规则编号是主记录的一部分，新增/换版时补齐对应行，
 * 已有行的状态（提交校验/启用/停用结果）保留，便于页面回查。
 */
export function ensureExtractorRuleRows(template: EntryRow[], expectedRuleNos: string[]): EntryRow[] {
  const stored = listRows('extractor')
  const byNo = new Map(stored.map((row) => [String(row['规则编号'] ?? ''), row]))
  const aligned = expectedRuleNos.map((ruleNo, index) => {
    const existing = byNo.get(ruleNo)
    const fallback = template[index]
    if (!existing) {
      return { ...clone(fallback), id: index + 1, '规则编号': ruleNo }
    }
    return { ...clone(existing), id: index + 1, '规则编号': ruleNo }
  })
  const same =
    stored.length === aligned.length &&
    stored.every((row, index) => String(row.id) === String(aligned[index].id) && String(row['规则编号']) === String(aligned[index]['规则编号']))
  if (!same) {
    saveRows('extractor', aligned)
    return aligned
  }
  return stored
}
