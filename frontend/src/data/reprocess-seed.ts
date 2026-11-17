import type { EntryRow } from './types'
import type {
  BusinessStatus,
  CostComparison,
  Dataset,
  DatasetRow,
  DiffResult,
  ExtractorUiState,
  FieldDiff,
  MappingRule,
  MappingVersion,
  RawRecord,
  RecordWorkbenchRow,
  ReprocessState,
  StorageUiState,
} from './reprocess-types'

const BUSINESS_FIELDS = ['商品名称', '类目', '销售价', '库存数量', '供应商', '发布时间', '商品链接']

const INITIAL_DATE = '2026-11-17'

const RULE_SEED = [
  { key: 1, target: '商品名称', source: 'title' },
  { key: 2, target: '类目', source: 'category' },
  { key: 3, target: '销售价', source: 'price' },
  { key: 4, target: '库存数量', source: 'stock' },
  { key: 5, target: '供应商', source: 'seller' },
  { key: 6, target: '发布时间', source: 'publish_time' },
  { key: 7, target: '商品链接', source: 'detail_url' },
]

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function seedVersions(): MappingVersion[] {
  // 上一版完整映射对文本列已做过去空格；本次差异只落在价格/类目/库存三列。
  const baseCleanse: Record<string, string> = {
    商品名称: 'trim(title)',
    供应商: 'trim(seller)',
    发布时间: 'trim(publish_time)',
    商品链接: 'trim(detail_url)',
  }
  const baseRules: MappingRule[] = RULE_SEED.map((item) => ({
    ruleNo: `EXTR-000${item.key}`,
    sourceField: item.source,
    targetField: item.target,
    typeCast: 'string',
    defaultValue: '',
    cleanseExpr: baseCleanse[item.target] ?? '',
    required: item.key <= 3,
    uniqueCheck: item.key === 1,
  }))

  const currentRules: MappingRule[] = baseRules.map((rule) => {
    const next = { ...rule }
    if (rule.targetField === '销售价') {
      next.typeCast = 'decimal(10,2)'
      next.cleanseExpr = 'trim(price)'
    }
    if (rule.targetField === '类目') {
      next.cleanseExpr = 'trim(category)'
      next.defaultValue = '未分类'
    }
    if (rule.targetField === '库存数量') {
      next.typeCast = 'int'
      next.defaultValue = '0'
    }
    return next
  })

  return [
    {
      versionId: 'MV-0001',
      label: '映射版本 V1',
      createdAt: '2026-11-10 09:00',
      status: '完整版本',
      note: '首版完整映射，已全量落盘，作为本次差异重算的上一版完整结果。',
      rules: baseRules,
    },
    {
      versionId: 'MV-0002',
      label: '映射版本 V2',
      createdAt: `${INITIAL_DATE} 09:30`,
      status: '当前草稿',
      note: '本次变更：销售价同时调整类型转换与清洗表达式，类目调整清洗表达式，库存数量调整类型转换与默认值。',
      rules: currentRules,
    },
  ]
}

export function seedRecords(): RawRecord[] {
  const sellers = ['华南优选', '云仓直供', '产地联盟', '城市仓储', '跨境严选', '工厂直营']
  const categories = ['家用电器', '数码配件', '家居日用', '户外装备', '食品生鲜']
  const records: RawRecord[] = []
  for (let index = 1; index <= 20; index += 1) {
    // 价格保留 1 位小数并夹杂空白：V2 的 decimal(10,2)+trim 才能产生可见变化。
    const price = `${index % 3 === 0 ? ' ' : ''}${(9.9 * (index + 2) + index * 0.37).toFixed(1)}${index % 4 === 0 ? ' ' : ''}`
    const publish = index % 3 === 0
      ? ` ${INITIAL_DATE.slice(0, 8)}${String(10 + (index % 7)).padStart(2, '0')} `
      : `${INITIAL_DATE.slice(0, 8)}${String(10 + (index % 7)).padStart(2, '0')}`
    records.push({
      recordId: `REC-${String(index).padStart(4, '0')}`,
      bizDate: index % 4 === 0 ? '2026-11-16' : INITIAL_DATE,
      sourceUrl: `https://example-goods.test/detail/${index}`,
      raw: {
        title: `  商品标题 ${String(index).padStart(2, '0')}  `,
        category: index % 5 === 0 ? '' : ` ${categories[index % categories.length]} `,
        price,
        stock: index % 6 === 0 ? '' : String((index * 13) % 97),
        seller: sellers[index % sellers.length],
        publish_time: publish,
        detail_url: `https://example-goods.test/detail/${index}`,
      },
    })
  }
  return records
}

export function applyRule(raw: Record<string, string>, rule: MappingRule): string {
  let value = String(raw[rule.sourceField] ?? '')
  if (rule.cleanseExpr.trim() !== '') {
    const expr = rule.cleanseExpr
    if (/fail|throw|异常/i.test(expr)) {
      throw new Error(`清洗表达式执行失败：${expr}`)
    }
    if (/^upper\(/i.test(expr)) {
      value = value.trim().toUpperCase()
    } else if (/^lower\(/i.test(expr)) {
      value = value.trim().toLowerCase()
    } else {
      value = value.trim()
    }
  }
  if (/decimal/i.test(rule.typeCast)) {
    const parsed = Number(value)
    value = value.trim() === '' || Number.isNaN(parsed) ? rule.defaultValue : parsed.toFixed(2)
  } else if (/int/i.test(rule.typeCast)) {
    const parsed = Number.parseInt(value, 10)
    value = value.trim() === '' || Number.isNaN(parsed)
      ? (rule.defaultValue !== '' ? rule.defaultValue : '0')
      : String(parsed)
  } else if (/date/i.test(rule.typeCast)) {
    value = value.trim().replace(/^(\d{4})\/(\d{2})\/(\d{2})$/, '$1-$2-$3')
  }
  if (value === '' && rule.defaultValue !== '') {
    value = rule.defaultValue
  }
  if (rule.required && value === '') {
    throw new Error(`目标字段「${rule.targetField}」必填为空`)
  }
  return value
}

export function diffVersions(versions: MappingVersion[], baseVersionId: string, versionId: string): DiffResult {
  const base = versions.find((item) => item.versionId === baseVersionId)
  const current = versions.find((item) => item.versionId === versionId)
  if (!base || !current) {
    throw new Error('映射版本不存在')
  }
  const byTarget = new Map<string, { oldRule?: MappingRule; newRule?: MappingRule }>()
  for (const rule of base.rules) {
    byTarget.set(rule.targetField, { oldRule: rule })
  }
  for (const rule of current.rules) {
    const slot = byTarget.get(rule.targetField) ?? {}
    slot.newRule = rule
    byTarget.set(rule.targetField, slot)
  }
  const fields: FieldDiff[] = []
  for (const [targetField, pair] of byTarget) {
    const changes: FieldDiff['changeTypes'] = []
    const { oldRule, newRule } = pair
    if (oldRule && !newRule) {
      changes.push('删除规则')
    } else if (!oldRule && newRule) {
      changes.push('新增规则')
    } else if (oldRule && newRule) {
      if (oldRule.ruleNo !== newRule.ruleNo) changes.push('规则编号变更')
      if (oldRule.sourceField !== newRule.sourceField) changes.push('源字段变更')
      if (oldRule.typeCast !== newRule.typeCast) changes.push('类型转换变更')
      if (oldRule.cleanseExpr !== newRule.cleanseExpr) changes.push('清洗表达式变更')
      if (oldRule.defaultValue !== newRule.defaultValue) changes.push('默认填充值变更')
      if (oldRule.required !== newRule.required) changes.push('必填标识变更')
      if (oldRule.uniqueCheck !== newRule.uniqueCheck) changes.push('唯一性校验变更')
    }
    if (changes.length === 0) continue
    fields.push({
      targetField,
      ruleNo: newRule?.ruleNo ?? oldRule?.ruleNo ?? '',
      changeTypes: changes,
      oldRule,
      newRule,
      conflict: changes.includes('类型转换变更') && changes.includes('清洗表达式变更'),
    })
  }
  fields.sort((a, b) => a.targetField.localeCompare(b.targetField, 'zh-CN'))
  const changed = new Set(fields.map((item) => item.targetField))
  return {
    baseVersionId,
    versionId,
    fields,
    conflictFields: fields.filter((item) => item.conflict).map((item) => item.targetField),
    unchangedFields: BUSINESS_FIELDS.filter((item) => !changed.has(item)),
  }
}

/** 上一版完整结果：用上一版完整映射跑出来、并合入人工修订后的值。 */
export function seedDataset(records: RawRecord[], baseRules: MappingRule[], baseVersionId: string): Dataset {
  const rows: Record<string, DatasetRow> = {}
  const lastCompleteValues: Record<string, Record<string, string>> = {}
  for (const record of records) {
    const values: Record<string, string> = {}
    for (const rule of baseRules) {
      try {
        values[rule.targetField] = applyRule(record.raw, rule)
      } catch {
        values[rule.targetField] = ''
      }
    }
    const manualEdits: string[] = []
    if (record.recordId === 'REC-0004') {
      values['类目'] = '手工修正类目'
      manualEdits.push('类目')
    }
    if (record.recordId === 'REC-0009') {
      values['商品名称'] = `${values['商品名称']}（人工改名）`
      manualEdits.push('商品名称')
    }
    rows[record.recordId] = {
      recordId: record.recordId,
      values,
      manualEdits,
      appliedVersionId: baseVersionId,
      bizStatus: '正常',
      updatedAt: '2026-11-17 08:00',
    }
    lastCompleteValues[record.recordId] = { ...values }
  }
  return { completeVersionId: baseVersionId, rows, lastCompleteValues, updatedAt: '2026-11-17 08:00' }
}

export function defaultExtractorUi(baseVersionId: string, versionId: string, focusRecordId: string): ExtractorUiState {
  return {
    tab: 'reprocess',
    baseVersionId,
    versionId,
    search: { targetField: '', recordId: '', ruleNo: '', status: '' },
    focusRecordId,
  }
}

export function defaultStorageUi(): StorageUiState {
  return { tab: 'writeback', targetField: '', recordId: '', status: '', focusRecordId: 'REC-0004' }
}

export function seedReprocess(): ReprocessState {
  const versions = seedVersions()
  const records = seedRecords()
  const base = versions.find((item) => item.status === '完整版本') ?? versions[0]
  const current = versions.find((item) => item.status === '当前草稿') ?? versions[versions.length - 1]
  return {
    schemaVersion: 1,
    versions,
    records,
    dataset: seedDataset(records, base.rules, base.versionId),
    plans: {},
    runs: {},
    decisions: {},
    verifications: {},
    logs: [
      {
        id: 'LOG-0001',
        at: '2026-11-17 09:00',
        level: 'info',
        message: `字段映射版本 ${base.versionId} 已全量落盘，覆盖 ${records.length} 条业务记录；${current.versionId} 已登记，等待差异重算。`,
      },
    ],
    ui: {
      extractor: defaultExtractorUi(base.versionId, current.versionId, 'REC-0002'),
      storage: defaultStorageUi(),
    },
    failureRecordId: '',
    qualityIssueRecordId: '',
    storageTarget: {
      configNo: 'STOR-0001',
      outputPath: '/data/warehouse/goods',
      datasetName: 'goods_detail',
      writeMode: 'upsert',
    },
  }
}

export function businessStatusOf(state: ReprocessState, recordId: string): BusinessStatus {
  return state.dataset.rows[recordId]?.bizStatus ?? '正常'
}

export function recordSummary(state: ReprocessState, versionId: string, recordId: string): RecordWorkbenchRow | null {
  const record = state.records.find((item) => item.recordId === recordId)
  const datasetRow = state.dataset.rows[recordId]
  if (!record || !datasetRow) return null
  const plan = state.plans[versionId]
  const entries = plan?.entries.filter((item) => item.recordId === recordId) ?? []
  const affected = [...new Set(entries.map((item) => item.targetField))]
  const replace = [...new Set(entries.filter((item) => item.changed).map((item) => item.targetField))]
  const written = entries.length > 0 && entries.every((item) => item.status === '已写入' || item.status === '已跳过')
  return {
    recordId,
    bizDate: record.bizDate,
    bizStatus: datasetRow.bizStatus,
    affectedFields: affected,
    replaceFields: replace,
    preservedFields: BUSINESS_FIELDS.filter((item) => !replace.includes(item)),
    recomputeStatus: entries.some((item) => item.status === '写入失败')
      ? '写入失败'
      : written
        ? '已写入'
        : '待写入',
    written,
    reviewed: datasetRow.bizStatus === '已复核',
  }
}

export function costOf(fields: FieldDiff[], records: number): CostComparison {
  const changedFields = fields.length
  const conflictFields = fields.filter((item) => item.conflict).length
  const fieldCells = changedFields * records
  const rowCells = records * BUSINESS_FIELDS.length
  return {
    changedFields,
    affectedRecords: records,
    totalFields: BUSINESS_FIELDS.length,
    fieldCells,
    rowCells,
    untouchedCells: rowCells - fieldCells,
    fieldMs: Math.max(12, fieldCells * 3 + conflictFields * 8),
    rowMs: Math.max(20, rowCells * 3),
    fieldScope: `仅替换 ${changedFields} 个受影响目标字段，其他 ${BUSINESS_FIELDS.length - changedFields} 列继续引用上一版完整结果`,
    rowScope: `命中 ${records} 条记录整行重算，写入 ${rowCells} 个单元格（含 ${rowCells - fieldCells} 个未变化列）`,
  }
}

export function newId(prefix: string, existing: string[]): string {
  const taken = new Set(existing)
  let index = existing.length + 1
  let candidate = `${prefix}-${String(index).padStart(4, '0')}`
  while (taken.has(candidate)) {
    index += 1
    candidate = `${prefix}-${String(index).padStart(4, '0')}`
  }
  return candidate
}

export function nowStamp(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function allBusinessFields(): string[] {
  return [...BUSINESS_FIELDS]
}

/** 映射规则状态取已登记的规则行（按规则编号对应），没有再按版本状态兜底，便于页面动作流转后回查。 */
export function extractorRulesAsEntries(version: MappingVersion, sourceRows: EntryRow[]): EntryRow[] {
  const defaultStatus = version.status === '当前草稿' ? '待校验' : '已启用'
  const storedByNo = new Map(sourceRows.map((row) => [String(row['规则编号'] ?? ''), row]))
  return version.rules.map((rule, index) => {
    const base = storedByNo.get(rule.ruleNo) ?? sourceRows[index] ?? {}
    const status = typeof base.status === 'string' && base.status !== '' ? String(base.status) : defaultStatus
    return {
      ...clone(base),
      id: index + 1,
      status,
      pending: status !== '已启用',
      abnormal: false,
      '规则编号': rule.ruleNo,
      '源字段名称': rule.sourceField,
      '目标字段名称': rule.targetField,
      '数据类型转换': rule.typeCast,
      '默认填充值': rule.defaultValue,
      '清洗表达式': rule.cleanseExpr,
      '必填标识': rule.required ? '是' : '否',
      '唯一性校验': rule.uniqueCheck ? '是' : '否',
    }
  })
}
