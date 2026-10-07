// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useRevisionStore } from './revision'
import { createStarterSchema } from '../utils/schema'
import type { DraftDoc, FieldChange } from '../utils/revision'

const BASELINE_KEY = 'formcraft:baseline:v1'
const DRAFT_KEY = 'formcraft:draft:v1'
const LEGACY_KEY = 'formcraft-schema-v1'
const LEGACY_BACKUP_KEY = 'formcraft:legacy-backup:v1'

function readDraft(): DraftDoc {
  return JSON.parse(localStorage.getItem(DRAFT_KEY)!) as DraftDoc
}

function labelChange(fieldId: string, value: string): FieldChange[] {
  return [{ kind: 'set', path: `set:${fieldId}:label`, fieldId, key: 'label', value }]
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.restoreAllMocks()
  setActivePinia(createPinia())
})

describe('revision store', () => {
  it('提交修订：携带操作号、基线版本与本侧改动，并写入本地', () => {
    const store = useRevisionStore()
    const nodeId = store.baseline.schema.nodes[0].id
    const revision = store.submitChanges(labelChange(nodeId, '新标题'))!
    expect(revision.opId).toBeTruthy()
    expect(revision.baseVersion).toBe(store.baseline.version)
    expect(revision.tabId).toBe(store.tabId)
    expect(revision.changes).toHaveLength(1)
    expect(store.revisionCount).toBe(1)

    const stored = readDraft()
    expect(stored.revisions).toHaveLength(1)
    expect(stored.revisions[0].opId).toBe(revision.opId)
    expect(store.mergedSchema.nodes[0].label).toBe('新标题')
  })

  it('同号重放只生成一次修订', () => {
    const store = useRevisionStore()
    const nodeId = store.baseline.schema.nodes[0].id
    const first = store.submitChanges(labelChange(nodeId, '值'), 'op_replay')
    const replayed = store.submitChanges(labelChange(nodeId, '值'), 'op_replay')
    expect(first).not.toBeNull()
    expect(replayed).toBeNull()
    expect(store.revisionCount).toBe(1)
    expect(readDraft().revisions).toHaveLength(1)
  })

  it('写入失败后原批次保留，可继续重试且不重复生成', () => {
    const store = useRevisionStore()
    const nodeId = store.baseline.schema.nodes[0].id
    vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('QuotaExceededError')
    })
    const revision = store.submitChanges(labelChange(nodeId, '失败批次'))!
    expect(store.persistError).toBe('QuotaExceededError')
    expect(store.pendingRetry).toBe(true)
    // 批次仍留在本侧文档与合并结果中
    expect(store.revisionCount).toBe(1)
    expect(store.mergedSchema.nodes[0].label).toBe('失败批次')

    expect(store.retryPersist()).toBe(true)
    expect(store.persistError).toBeNull()
    expect(store.pendingRetry).toBe(false)
    const stored = readDraft()
    expect(stored.revisions.filter((item) => item.opId === revision.opId)).toHaveLength(1)
  })

  it('旧版无版本草稿先迁移为基线 v1，原内容完整保留', () => {
    const legacy = createStarterSchema()
    legacy.title = '旧版草稿标题'
    localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy))

    const store = useRevisionStore()
    expect(store.migratedFromLegacy).toBe(true)
    expect(store.baseline.version).toBe(1)
    expect(store.baseline.schema.title).toBe('旧版草稿标题')
    expect(store.baseline.schema.nodes.map((node) => node.id)).toEqual(legacy.nodes.map((node) => node.id))
    expect(store.revisionCount).toBe(0)
    expect(store.mergedSchema.title).toBe('旧版草稿标题')
    // 旧 key 清除、内容留有备份
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
    expect(localStorage.getItem(LEGACY_BACKUP_KEY)).toBe(JSON.stringify(legacy))
    expect(readDraft().baseVersion).toBe(1)
  })

  it('悬空引用挡住发布，逐条修复后可发布为新基线', () => {
    const store = useRevisionStore()
    const typeNode = store.baseline.schema.nodes.find((node) => node.name === 'requestType')!

    store.submitChanges([{ kind: 'remove', path: `remove:${typeNode.id}`, fieldId: typeNode.id, value: true }])
    expect(store.dangling.length).toBeGreaterThan(0)
    expect(store.canPublish).toBe(false)
    expect(store.publishBlockers.some((item) => item.includes('悬空'))).toBe(true)
    expect(store.publish()).toBe(false)
    expect(store.baseline.version).toBe(1)

    for (const item of [...store.dangling]) {
      store.submitChanges([{ kind: 'set', path: `set:${item.ownerId}:condition`, fieldId: item.ownerId, key: 'condition', cleared: true }])
    }
    expect(store.dangling).toHaveLength(0)
    expect(store.canPublish).toBe(true)

    expect(store.publish()).toBe(true)
    expect(store.baseline.version).toBe(2)
    expect(store.revisionCount).toBe(0)
    expect(store.mergedSchema.nodes.find((node) => node.id === typeNode.id)).toBeUndefined()
    expect(JSON.parse(localStorage.getItem(BASELINE_KEY)!).version).toBe(2)
  })

  it('其他标签页写入后重新载入：同路径冲突留双方值，解决后才能发布', () => {
    const store = useRevisionStore()
    const nodeId = store.baseline.schema.nodes[0].id
    store.submitChanges(labelChange(nodeId, '本侧值'))

    // 模拟另一个标签页：在已持久化文档上追加自己的修订（读-改-写）
    const current = readDraft()
    const foreign: DraftDoc = {
      baseVersion: 1,
      revisions: [
        ...current.revisions,
        {
          opId: 'op_foreign',
          tabId: 'tab_other',
          tabLabel: '标签页·OTHER',
          baseVersion: 1,
          changes: labelChange(nodeId, '对侧值'),
          createdAt: new Date().toISOString(),
        },
      ],
      resolutions: {},
    }
    localStorage.setItem(DRAFT_KEY, JSON.stringify(foreign))
    store.reloadFromStorage()

    expect(store.revisionCount).toBe(2)
    expect(store.conflicts).toHaveLength(1)
    expect(store.conflicts[0].sides.map((side) => side.value)).toEqual(['本侧值', '对侧值'])
    expect(store.canPublish).toBe(false)
    expect(store.publish()).toBe(false)

    const foreignSide = store.conflicts[0].sides.find((side) => side.tabId === 'tab_other')!
    store.resolveConflict(store.conflicts[0].path, foreignSide)
    expect(store.conflicts).toHaveLength(0)
    expect(store.mergedSchema.nodes[0].label).toBe('对侧值')
    expect(store.publish()).toBe(true)
    expect(store.baseline.version).toBe(2)
  })

  it('合并结果变化会推进 mergeVersion，驱动条件与预览重算', async () => {
    const store = useRevisionStore()
    const before = store.mergeVersion
    const nodeId = store.baseline.schema.nodes[0].id
    store.submitChanges(labelChange(nodeId, '触发重算'))
    await nextTick()
    expect(store.mergeVersion).toBeGreaterThan(before)
  })
})
