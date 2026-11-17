/** 字段映射增量重算（差异重处理）的数据结构。 */

export type RuleChangeType =
  | '新增规则'
  | '删除规则'
  | '规则编号变更'
  | '源字段变更'
  | '类型转换变更'
  | '清洗表达式变更'
  | '默认填充值变更'
  | '必填标识变更'
  | '唯一性校验变更'

export type MappingRule = {
  ruleNo: string
  sourceField: string
  targetField: string
  typeCast: string
  defaultValue: string
  cleanseExpr: string
  required: boolean
  uniqueCheck: boolean
}

export type MappingVersionStatus = '历史版本' | '完整版本' | '当前草稿'

export type MappingVersion = {
  versionId: string
  label: string
  createdAt: string
  status: MappingVersionStatus
  note: string
  rules: MappingRule[]
}

export type FieldDiff = {
  targetField: string
  ruleNo: string
  changeTypes: RuleChangeType[]
  oldRule?: MappingRule
  newRule?: MappingRule
  /** 同一目标字段同时发生类型转换与清洗表达式变化时，字段级/整行级写入范围冲突。 */
  conflict: boolean
}

export type DiffResult = {
  baseVersionId: string
  versionId: string
  fields: FieldDiff[]
  conflictFields: string[]
  unchangedFields: string[]
}

export type RawRecord = {
  recordId: string
  bizDate: string
  sourceUrl: string
  raw: Record<string, string>
}

export type BusinessStatus = '正常' | '待复核' | '已复核' | '异常'

export type DatasetRow = {
  recordId: string
  values: Record<string, string>
  /** 下游人工修订过的列，字段级重算不得覆盖。 */
  manualEdits: string[]
  appliedVersionId: string
  bizStatus: BusinessStatus
  updatedAt: string
}

export type Dataset = {
  completeVersionId: string
  rows: Record<string, DatasetRow>
  /** 上一版完整结果；未变化列始终引用这里。 */
  lastCompleteValues: Record<string, Record<string, string>>
  updatedAt: string
}

export type RecomputeStrategy = '字段级' | '整行'

export type ManifestEntryStatus = '待写入' | '已写入' | '写入失败' | '已跳过'

export type ManifestEntry = {
  id: string
  versionId: string
  baseVersionId: string
  recordId: string
  bizDate: string
  ruleNo: string
  targetField: string
  changeTypes: RuleChangeType[]
  oldValue: string
  newValue: string
  changed: boolean
  required: boolean
  uniqueCheck: boolean
  strategy: RecomputeStrategy
  status: ManifestEntryStatus
  /** 映射计算失败（必填为空/清洗表达式异常）：不能写入，须先修规则或数据。 */
  calcFailed?: boolean
  message?: string
  updatedAt: string
}

export type CostComparison = {
  changedFields: number
  affectedRecords: number
  totalFields: number
  fieldCells: number
  rowCells: number
  untouchedCells: number
  fieldMs: number
  rowMs: number
  fieldScope: string
  rowScope: string
}

export type ConflictDecision = {
  versionId: string
  baseVersionId: string
  targetFields: string[]
  strategy: RecomputeStrategy
  basis: string
  decidedAt: string
  cost: CostComparison
}

export type Plan = {
  versionId: string
  baseVersionId: string
  strategy: RecomputeStrategy
  runId: string
  createdAt: string
  verifiedAt?: string
  changedFields: string[]
  conflictFields: string[]
  affectedRecordIds: string[]
  entries: ManifestEntry[]
  /** 生成清单时的数据质量演练参数，变了必须刷新重算。 */
  inputIssueRecordId?: string
}

export type Verification = {
  versionId: string
  baseVersionId: string
  at: string
  strategy: RecomputeStrategy
  note: string
}

export type RunStatus = '待执行' | '执行中' | '部分回写' | '已中断' | '失败' | '已完成'

export type ReprocessRun = {
  runId: string
  versionId: string
  baseVersionId: string
  strategy: RecomputeStrategy
  status: RunStatus
  totalEntries: number
  totalRecords: number
  writtenEntries: number
  writtenRecords: number
  checkpoint: number
  startedAt: string
  updatedAt: string
  lastError?: string
}

export type ReprocessLog = {
  id: string
  at: string
  level: 'info' | 'warn' | 'error' | 'success'
  message: string
}

export type ManifestSearch = {
  targetField: string
  recordId: string
  ruleNo: string
  status: string
}

export type ExtractorUiState = {
  tab: 'reprocess' | 'ledger' | 'rules'
  baseVersionId: string
  versionId: string
  search: ManifestSearch
  focusRecordId: string
}

export type StorageUiState = {
  tab: 'writeback' | 'config'
  targetField: string
  recordId: string
  status: string
  focusRecordId: string
}

export type StorageTarget = {
  configNo: string
  outputPath: string
  datasetName: string
  writeMode: string
}

export type ReprocessState = {
  schemaVersion: number
  versions: MappingVersion[]
  records: RawRecord[]
  dataset: Dataset
  plans: Record<string, Plan>
  runs: Record<string, ReprocessRun>
  decisions: Record<string, ConflictDecision>
  verifications: Record<string, Verification>
  logs: ReprocessLog[]
  ui: {
    extractor: ExtractorUiState
    storage: StorageUiState
  }
  /** 落盘故障注入：命中该记录时中断批次，用来验证「不写一半」。 */
  failureRecordId: string
  /** 数据质量演练：该记录的源价格置空，用来验证必填标识处理会拦住重算清单写入。 */
  qualityIssueRecordId: string
  storageTarget: StorageTarget
}

export type ReprocessResult<T = undefined> = {
  ok: boolean
  message: string
  data?: T
}

export type RecordWorkbenchRow = {
  recordId: string
  bizDate: string
  bizStatus: BusinessStatus
  affectedFields: string[]
  replaceFields: string[]
  preservedFields: string[]
  recomputeStatus: string
  written: boolean
  reviewed: boolean
}
