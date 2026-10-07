// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useDesignerStore } from './designer'
import { useRevisionStore } from './revision'
import type { DraftDoc, Revision } from '../utils/revision'

const DRAFT_KEY = 'formcraft:draft:v1'

function readDraft(): DraftDoc {
  return JSON.parse(localStorage.getItem(DRAFT_KEY)!) as DraftDoc
}

function foreignRevision(fieldId: string, value: string): Revision {
  return {
    opId: `op_foreign_${value}`,
    tabId: 'tab_other',
    tabLabel: '标签页·OTHER',
    baseVersion: 1,
    changes: [{ kind: 'set', path: `set:${fieldId}:label`, fieldId, key: 'label', value }],
    createdAt: new Date().toISOString(),
  }
}

function simulateRemoteWrite(revision: Revision) {
  const current = readDraft()
  const next: DraftDoc = { ...current, revisions: [...current.revisions, revision] }
  localStorage.setItem(DRAFT_KEY, JSON.stringify(next))
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.restoreAllMocks()
  setActivePinia(createPinia())
})

describe('designer store（离线修订集成）', () => {
  it('画布编辑经 diff 生成修订提交，携带操作号与基线版本', () => {
    const revisionStore = useRevisionStore()
    const store = useDesignerStore()
    const nodeId = store.nodes[0].id
    store.selectedId = nodeId
    store.updateSelected({ label: '设计器改名' })
    store.flushCommit()

    expect(revisionStore.revisionCount).toBe(1)
    const revision = readDraft().revisions[0]
    expect(revision.opId).toBeTruthy()
    expect(revision.baseVersion).toBe(revisionStore.baseline.version)
    expect(revision.changes[0].path).toBe(`set:${nodeId}:label`)
    expect(revisionStore.mergedSchema.nodes[0].label).toBe('设计器改名')
    expect(store.dirty).toBe(false)
  })

  it('本侧干净时远端修订直接合入工作副本', async () => {
    const revisionStore = useRevisionStore()
    const store = useDesignerStore()
    const nodeId = store.nodes[0].id

    simulateRemoteWrite(foreignRevision(nodeId, '远端值'))
    revisionStore.reloadFromStorage()
    await nextTick()
    await nextTick()

    expect(store.remotePending).toBe(false)
    expect(store.nodes[0].label).toBe('远端值')
    expect(store.dirty).toBe(false)
  })

  it('本侧有未提交编辑时远端更新只标记不覆盖，提交后双向合入', async () => {
    const revisionStore = useRevisionStore()
    const store = useDesignerStore()
    const localId = store.nodes[0].id
    const remoteId = store.nodes[1].id

    store.selectedId = localId
    store.updateSelected({ label: '本侧未提交' })
    expect(store.dirty).toBe(true)

    simulateRemoteWrite(foreignRevision(remoteId, '远端值'))
    revisionStore.reloadFromStorage()
    await nextTick()
    await nextTick()

    // 本侧未提交的编辑不被覆盖
    expect(store.remotePending).toBe(true)
    expect(store.nodes[0].label).toBe('本侧未提交')

    store.flushCommit()
    await nextTick()
    await nextTick()

    // 不同路径直接合入：两侧改动都在合并结果里
    expect(revisionStore.conflicts).toHaveLength(0)
    expect(revisionStore.mergedSchema.nodes[0].label).toBe('本侧未提交')
    expect(revisionStore.mergedSchema.nodes[1].label).toBe('远端值')
    expect(store.remotePending).toBe(false)
    expect(store.nodes[1].label).toBe('远端值')
  })

  it('同一路径两侧都改：合并留冲突，工作副本采用先写入值', async () => {
    const revisionStore = useRevisionStore()
    const store = useDesignerStore()
    const nodeId = store.nodes[0].id

    // 本侧先提交
    store.selectedId = nodeId
    store.updateSelected({ label: '本侧值' })
    store.flushCommit()

    // 远端同路径提交不同值
    simulateRemoteWrite(foreignRevision(nodeId, '远端值'))
    revisionStore.reloadFromStorage()
    await nextTick()
    await nextTick()

    expect(revisionStore.conflicts).toHaveLength(1)
    expect(store.nodes[0].label).toBe('本侧值') // 先写入者临时生效
    expect(revisionStore.canPublish).toBe(false)

    // 采用远端值解决后，工作副本同步更新
    const side = revisionStore.conflicts[0].sides.find((item) => item.tabId === 'tab_other')!
    revisionStore.resolveConflict(revisionStore.conflicts[0].path, side)
    await nextTick()
    await nextTick()
    expect(store.nodes[0].label).toBe('远端值')
    expect(revisionStore.canPublish).toBe(true)
  })
})
