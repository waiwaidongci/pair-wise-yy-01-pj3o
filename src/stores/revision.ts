import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { FormSchema } from '../types/form'
import { createId } from '../utils/id'
import { cloneSchema, createStarterSchema } from '../utils/schema'
import {
  appendRevision,
  createRevision,
  emptyDraft,
  mergeDraft,
  mergeStoredDraft,
  migrateLegacySchema,
  upsertResolution,
  type BaselineDoc,
  type ConflictEntry,
  type DanglingRef,
  type DraftDoc,
  type FieldChange,
  type MergeResult,
  type Resolution,
  type Revision,
} from '../utils/revision'

const BASELINE_KEY = 'formcraft:baseline:v1'
const DRAFT_KEY = 'formcraft:draft:v1'
const LEGACY_KEY = 'formcraft-schema-v1'
const LEGACY_BACKUP_KEY = 'formcraft:legacy-backup:v1'
const TAB_KEY = 'formcraft:tab-id'

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function resolveTabId(): string {
  try {
    const existing = sessionStorage.getItem(TAB_KEY)
    if (existing) return existing
    const created = createId('tab')
    sessionStorage.setItem(TAB_KEY, created)
    return created
  } catch {
    return createId('tab')
  }
}

interface LoadedState {
  baseline: BaselineDoc
  draft: DraftDoc
  source: 'stored' | 'migrated' | 'fresh'
}

function loadPersisted(): LoadedState {
  const storedBaseline = readJson<BaselineDoc>(BASELINE_KEY)
  const storedDraft = readJson<DraftDoc>(DRAFT_KEY)
  if (storedBaseline && storedDraft) return { baseline: storedBaseline, draft: storedDraft, source: 'stored' }
  if (storedBaseline && !storedDraft) {
    return { baseline: storedBaseline, draft: emptyDraft(storedBaseline.version), source: 'stored' }
  }

  // 旧稿缺少版本信息：先迁移为基线 v1 + 空草稿，原内容完整保留
  const legacyRaw = localStorage.getItem(LEGACY_KEY)
  if (legacyRaw) {
    const migrated = migrateLegacySchema(legacyRaw)
    if (migrated) {
      try {
        localStorage.setItem(BASELINE_KEY, JSON.stringify(migrated.baseline))
        localStorage.setItem(DRAFT_KEY, JSON.stringify(migrated.draft))
        localStorage.setItem(LEGACY_BACKUP_KEY, legacyRaw)
        localStorage.removeItem(LEGACY_KEY)
      } catch {
        // 写入失败则保留旧 key，下次加载重试迁移，内容不丢
      }
      return { ...migrated, source: 'migrated' }
    }
  }

  const baseline: BaselineDoc = {
    version: 1,
    schema: createStarterSchema(),
    publishedAt: new Date().toISOString(),
  }
  return { baseline, draft: emptyDraft(baseline.version), source: 'fresh' }
}

export const useRevisionStore = defineStore('revision', () => {
  const tabId = resolveTabId()
  const tabLabel = `标签页·${tabId.slice(-4).toUpperCase()}`

  const loaded = loadPersisted()
  const baseline = ref<BaselineDoc>(loaded.baseline)
  const draft = ref<DraftDoc>(loaded.draft)
  const migratedFromLegacy = ref(loaded.source === 'migrated')
  const persistError = ref<string | null>(null)
  /** 有批次写入失败、等待重试 */
  const pendingRetry = ref(false)
  /** 合并结果的版本号：一改动就推进，条件与预览依赖它立即失效重算 */
  const mergeVersion = ref(0)
  const lastPersistedAt = ref<string | null>(null)

  const merged = computed<MergeResult>(() => mergeDraft(baseline.value.schema, draft.value))
  const mergedSchema = computed<FormSchema>(() => merged.value.schema)
  const conflicts = computed<ConflictEntry[]>(() => merged.value.conflicts)
  const dangling = computed<DanglingRef[]>(() => merged.value.dangling)
  const revisionCount = computed(() => draft.value.revisions.length)
  const canPublish = computed(() => !persistError.value && conflicts.value.length === 0 && dangling.value.length === 0)
  const publishBlockers = computed(() => {
    const blockers: string[] = []
    if (conflicts.value.length) blockers.push(`${conflicts.value.length} 处同路径冲突待处理`)
    if (dangling.value.length) blockers.push(`${dangling.value.length} 处悬空联动条件待修复`)
    if (persistError.value) blockers.push('草稿写入失败，需先重试成功')
    return blockers
  })

  let lastMergedKey = ''
  watch(merged, (result) => {
    const key = `${JSON.stringify(result.schema)}#${result.conflicts.length}#${result.dangling.length}`
    if (key !== lastMergedKey) {
      lastMergedKey = key
      mergeVersion.value += 1
    }
  }, { immediate: true })

  function persistDraft(): void {
    // 读-改-写：先并入其他标签页已写入的修订，避免整份覆盖
    const stored = readJson<DraftDoc>(DRAFT_KEY)
    const next = stored ? mergeStoredDraft(stored, draft.value) : draft.value
    localStorage.setItem(DRAFT_KEY, JSON.stringify(next))
    draft.value = next
    lastPersistedAt.value = new Date().toISOString()
  }

  function persistBaseline(): void {
    // 不覆盖其他标签页发布的更新基线
    const stored = readJson<BaselineDoc>(BASELINE_KEY)
    if (stored && stored.version > baseline.value.version) {
      baseline.value = stored
      return
    }
    localStorage.setItem(BASELINE_KEY, JSON.stringify(baseline.value))
  }

  function runPersist(mode: 'draft' | 'both'): boolean {
    try {
      if (mode === 'both') persistBaseline()
      persistDraft()
      persistError.value = null
      pendingRetry.value = false
      return true
    } catch (error) {
      // 写入失败：修订已留在本侧文档中，原批次可继续重试
      persistError.value = error instanceof Error ? error.message : 'localStorage 写入失败'
      pendingRetry.value = true
      return false
    }
  }

  /**
   * 提交一个修订批次：携带操作号（opId）、基线版本和本侧改动。
   * 同号重放只生成一次修订；写入失败时批次保留在文档中，可经 retryPersist 重试。
   */
  function submitChanges(changes: FieldChange[], opId?: string): Revision | null {
    if (!changes.length) return null
    const revision = createRevision(tabId, tabLabel, draft.value.baseVersion, changes, opId)
    const { doc, added } = appendRevision(draft.value, revision)
    if (!added) return null
    draft.value = doc
    runPersist('draft')
    return revision
  }

  /** 写入失败后重试：重放当前文档（含失败批次），同号修订不会重复生成 */
  function retryPersist(): boolean {
    if (!pendingRetry.value) return true
    // 基线写入是幂等的（同内容重写 + 版本守卫），统一按完整模式重试
    return runPersist('both')
  }

  /** 采用某一侧的值解决同路径冲突 */
  function resolveConflict(path: string, side: { value?: unknown; cleared?: boolean }): void {
    const resolution: Resolution = {
      opId: createId('op'),
      path,
      value: side.value,
      cleared: side.cleared,
      baseVersion: draft.value.baseVersion,
      resolvedAt: new Date().toISOString(),
    }
    const { doc, added } = upsertResolution(draft.value, resolution)
    if (!added) return
    draft.value = doc
    runPersist('draft')
  }

  /** 发布：合并结果成为新基线，草稿清空；存在冲突或悬空引用时被挡住 */
  function publish(): boolean {
    if (!canPublish.value) return false
    baseline.value = {
      version: baseline.value.version + 1,
      schema: cloneSchema(mergedSchema.value),
      publishedAt: new Date().toISOString(),
    }
    draft.value = emptyDraft(baseline.value.version)
    return runPersist('both')
  }

  /** 其他标签页写入后重新载入，并与本侧未持久化的批次求并集 */
  function reloadFromStorage(): void {
    const storedBaseline = readJson<BaselineDoc>(BASELINE_KEY)
    if (
      storedBaseline
      && storedBaseline.version >= baseline.value.version
      && JSON.stringify(storedBaseline) !== JSON.stringify(baseline.value)
    ) {
      baseline.value = storedBaseline
    }
    const storedDraft = readJson<DraftDoc>(DRAFT_KEY)
    if (storedDraft) {
      const next = mergeStoredDraft(storedDraft, draft.value)
      if (JSON.stringify(next) !== JSON.stringify(draft.value)) draft.value = next
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key === DRAFT_KEY || event.key === BASELINE_KEY) reloadFromStorage()
    })
  }

  // 首次初始化（全新工作区）时立刻落盘，让同时打开的标签页收敛到同一份基线
  if (loaded.source === 'fresh') runPersist('both')

  return {
    tabId,
    tabLabel,
    baseline,
    draft,
    mergedSchema,
    conflicts,
    dangling,
    revisionCount,
    mergeVersion,
    persistError,
    pendingRetry,
    migratedFromLegacy,
    canPublish,
    publishBlockers,
    lastPersistedAt,
    submitChanges,
    retryPersist,
    resolveConflict,
    publish,
    reloadFromStorage,
  }
})
