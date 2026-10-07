import type { FormSchema } from '../types/form'
import type { CommitResult, Revision, SharedState, StoredRevision } from '../types/collab'
import { cloneSchema, createStarterSchema } from './schema'

const SHARED_KEY = 'formcraft-shared-v1'
const LEGACY_KEY = 'formcraft-schema-v1'

// Simulated offline write failure rate. The batch is always retained so the
// user can retry; replaying the same opId never creates a duplicate revision.
const WRITE_FAIL_RATE = 0.15

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function saveShared(state: SharedState): void {
  localStorage.setItem(SHARED_KEY, JSON.stringify(state))
}

function isSharedState(value: unknown): value is SharedState {
  if (!value || typeof value !== 'object') return false
  const s = value as SharedState
  return typeof s.baselineVersion === 'number' && !!s.baseline && Array.isArray(s.revisions)
}

/**
 * Load the shared state, migrating a legacy single-draft (which had no
 * version metadata) into the versioned baseline format while preserving its
 * content exactly.
 */
export function loadShared(): SharedState {
  try {
    const raw = localStorage.getItem(SHARED_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (isSharedState(parsed)) return parsed
    }
  } catch {
    // Corrupt shared state: fall through to migration / starter.
  }

  // Migrate the legacy one-draft format: keep the original content verbatim,
  // just wrap it with a baseline version and an empty revision log.
  try {
    const legacyRaw = localStorage.getItem(LEGACY_KEY)
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw) as FormSchema
      if (legacy && Array.isArray(legacy.nodes)) {
        const migrated: SharedState = {
          baselineVersion: 1,
          baseline: {
            version: 1,
            title: legacy.title,
            description: legacy.description,
            nodes: cloneSchema(legacy.nodes),
            updatedAt: legacy.updatedAt ?? new Date().toISOString(),
          },
          revisions: [],
          savedAt: new Date().toISOString(),
        }
        saveShared(migrated)
        return migrated
      }
    }
  } catch {
    // Ignore an unreadable legacy draft.
  }

  const starter = createStarterSchema()
  const init: SharedState = {
    baselineVersion: 1,
    baseline: starter,
    revisions: [],
    savedAt: new Date().toISOString(),
  }
  saveShared(init)
  return init
}

/**
 * Commit a tab's revision. Idempotent on opId: replaying the same opId
 * returns the existing revision without appending a duplicate. A failed
 * write leaves the caller's batch intact for retry.
 */
export async function commitRevision(rev: Revision): Promise<CommitResult> {
  await delay(120 + Math.random() * 220)

  // Simulated offline / storage write failure.
  if (Math.random() < WRITE_FAIL_RATE) {
    return { ok: false, error: '写入失败：本地存储暂不可用，原批次已保留，可重试' }
  }

  const state = loadShared()
  const existing = state.revisions.find((r) => r.opId === rev.opId)
  if (existing) {
    return { ok: true, deduped: true, revision: existing }
  }
  state.revisions.push(cloneSchema(rev) as StoredRevision)
  state.savedAt = new Date().toISOString()
  saveShared(state)
  return { ok: true, deduped: false, revision: state.revisions[state.revisions.length - 1] }
}

/** Publish the merged draft as the new baseline, clearing the revision log. */
export function publishBaseline(schema: FormSchema): SharedState {
  const state = loadShared()
  state.baselineVersion += 1
  state.baseline = {
    version: 1,
    title: schema.title,
    description: schema.description,
    nodes: cloneSchema(schema.nodes),
    updatedAt: new Date().toISOString(),
  }
  state.revisions = []
  state.savedAt = new Date().toISOString()
  saveShared(state)
  return state
}

/** Subscribe to cross-tab changes (storage event + polling fallback). */
export function subscribe(callback: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === SHARED_KEY) callback()
  }
  window.addEventListener('storage', onStorage)
  const timer = window.setInterval(callback, 1000)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.clearInterval(timer)
  }
}
