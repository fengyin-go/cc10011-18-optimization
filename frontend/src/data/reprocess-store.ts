/** 字段映射增量重算状态的 localStorage 持久化与订阅。 */
import { seedReprocess } from './reprocess-seed'
import type { ReprocessState } from './reprocess-types'

export const REPROCESS_STORAGE_KEY = 'scraper-strategy-studio:reprocess'

export const REPROCESS_EVENT = 'scraper-strategy-studio:reprocess-changed'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let cache: ReprocessState | null = null
let storageBroken = false

export function storageAvailable(): boolean {
  return !storageBroken
}

function readReprocess(): ReprocessState {
  const fallback = seedReprocess()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(REPROCESS_STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(REPROCESS_STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as ReprocessState
    if (!parsed || parsed.schemaVersion !== 1 || !parsed.versions || !parsed.dataset) {
      throw new Error('reprocess state schema mismatch')
    }
    return parsed
  } catch {
    window.localStorage.setItem(REPROCESS_STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

export function reprocessState(): ReprocessState {
  if (cache === null) {
    cache = readReprocess()
  }
  return cache
}

function notify(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(REPROCESS_EVENT))
  }
}

/** 原子提交：只有 localStorage 写成功后才替换内存状态，避免内存与磁盘不一致。 */
export function commitReprocess(state: ReprocessState): boolean {
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(REPROCESS_STORAGE_KEY, JSON.stringify(state))
    } catch {
      storageBroken = true
      notify()
      return false
    }
    storageBroken = false
  }
  cache = state
  notify()
  return true
}

export function resetReprocess(): ReprocessState {
  const fresh = seedReprocess()
  commitReprocess(fresh)
  return fresh
}

export function replaceReprocess(state: ReprocessState): ReprocessState {
  commitReprocess(state)
  return state
}

export function subscribeReprocess(listener: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => undefined
  }
  const handler = () => listener()
  window.addEventListener(REPROCESS_EVENT, handler)
  window.addEventListener('storage', handler)
  return () => {
    window.removeEventListener(REPROCESS_EVENT, handler)
    window.removeEventListener('storage', handler)
  }
}

export function cloneReprocess(state: ReprocessState): ReprocessState {
  return clone(state)
}
