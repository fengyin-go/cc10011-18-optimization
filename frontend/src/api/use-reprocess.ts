import { useEffect, useState } from 'react'

import { reprocessState, subscribeReprocess } from '@/data/reprocess-store'
import type { ReprocessState } from '@/data/reprocess-types'

/** 订阅增量重算状态：所有页面共享同一份 localStorage 数据。 */
export function useReprocess(): ReprocessState {
  const [state, setState] = useState<ReprocessState>(() => reprocessState())
  useEffect(() => subscribeReprocess(() => setState(reprocessState())), [])
  return state
}
