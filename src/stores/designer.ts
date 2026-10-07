import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { FieldNode, FormSchema } from '../types/form'
import type { DanglingRef, PathConflict, PathOp, Revision, StoredRevision, SyncStatus } from '../types/collab'
import { cloneSchema, createField, createStarterSchema, findNode, insertNode, moveNode, removeNode } from '../utils/schema'
import {
  applyOpsToSchema,
  diffMeta,
  diffSchemas,
  findDanglingRefs,
  flattenSchema,
  mergeThreeWay,
  parseNodePath,
  unflattenSchema,
} from '../utils/pathMerge'
import { commitRevision, loadShared, publishBaseline, subscribe } from '../utils/storageServer'
import { createId } from '../utils/id'

const TAB_ID = (() => {
  try {
    let id = sessionStorage.getItem('formcraft-tab-id')
    if (!id) {
      id = createId('tab')
      sessionStorage.setItem('formcraft-tab-id', id)
    }
    return id
  } catch {
    return createId('tab')
  }
})()

export const useDesignerStore = defineStore('designer', () => {
  const shared = loadShared()

  // ---- Shared baseline (published) and this tab's working draft ----------
  const baseline = ref<FormSchema>(cloneSchema(shared.baseline))
  const baselineVersion = ref<number>(shared.baselineVersion)
  const localDraft = ref<FormSchema>(cloneSchema(shared.baseline))
  const lastCommitted = ref<FormSchema>(cloneSchema(shared.baseline))

  // Revisions from other tabs folded onto the baseline.
  const remoteRevisions = ref<StoredRevision[]>(
    shared.revisions.filter((r) => r.tabId !== TAB_ID && r.baseVersion === shared.baselineVersion),
  )
  const revisions = ref<StoredRevision[]>(cloneSchema(shared.revisions))

  // Resolved conflicts keyed by path; pruned when the conflict disappears.
  const resolutions = ref<Record<string, unknown>>({})

  // ---- Sync / commit state ----------------------------------------------
  const syncStatus = ref<SyncStatus>('idle')
  const syncMessage = ref('')
  const pendingBatch = ref<Revision | null>(null)
  const schemaRev = ref(0) // bumped on every merge to invalidate derived views
  let commitTimer: number | undefined
  let commitInFlight = false
  let commitQueued = false

  // ---- Local undo history (snapshots of this tab's draft) ---------------
  const history = ref<FormSchema[]>([])
  const historyIndex = ref(-1)

  // ---- Selection ---------------------------------------------------------
  const selectedId = ref<string | null>(localDraft.value.nodes[0]?.id ?? null)

  // ---- Derived merge -----------------------------------------------------
  const remoteDraft = computed<FormSchema>(() => {
    let cur = cloneSchema(baseline.value)
    for (const rev of remoteRevisions.value) {
      cur = applyOpsToSchema(cur, rev.ops)
    }
    return cur
  })

  const rawMerge = computed(() => mergeThreeWay(baseline.value, localDraft.value, remoteDraft.value))

  const mergeResult = computed(() => {
    const result = rawMerge.value
    const active: PathConflict[] = []
    const nodes = new Map(result.nodes)
    let title = result.title
    let description = result.description

    result.conflicts.forEach((c) => {
      const resolution = resolutions.value[c.path]
      if (resolution !== undefined) {
        if (c.path === 'title') title = resolution as string
        else if (c.path === 'description') description = resolution as string
        else {
          const parsed = parseNodePath(c.path)
          if (parsed) {
            const fn = nodes.get(parsed.id)
            if (fn) nodes.set(parsed.id, { ...fn, [parsed.prop]: resolution })
          }
        }
      } else {
        active.push(c)
      }
    })

    return { nodes, title, description, conflicts: active }
  })

  const draft = computed<FormSchema>(() =>
    unflattenSchema(mergeResult.value.nodes, {
      title: mergeResult.value.title,
      description: mergeResult.value.description,
    }, 1),
  )

  const conflicts = computed<PathConflict[]>(() => mergeResult.value.conflicts)
  const danglingRefs = computed<DanglingRef[]>(() => findDanglingRefs(mergeResult.value.nodes))

  const canPublish = computed(() => conflicts.value.length === 0 && danglingRefs.value.length === 0)

  // ---- Public view of the schema (used by export / preview) --------------
  const title = computed<string>({
    get: () => draft.value.title,
    set: (v) => { localDraft.value = { ...localDraft.value, title: v } },
  })
  const description = computed<string>({
    get: () => draft.value.description,
    set: (v) => { localDraft.value = { ...localDraft.value, description: v } },
  })
  const nodes = computed<FieldNode[]>(() => draft.value.nodes)

  const selectedNode = computed(() => (selectedId.value ? findNode(nodes.value, selectedId.value) : undefined))
  const flatFields = computed(() => {
    const walk = (items: FieldNode[]): FieldNode[] => items.flatMap((item) => [item, ...walk(item.children ?? [])])
    return walk(nodes.value).filter((item) => ['input', 'select', 'date'].includes(item.type))
  })
  const schema = computed<FormSchema>(() => draft.value)

  const saveState = computed(() => {
    switch (syncStatus.value) {
      case 'syncing': return '正在保存修订…'
      case 'error': return `保存失败：${syncMessage.value ?? '可重试'}`
      case 'synced': return syncMessage.value || '已同步'
      case 'pending': return '有未提交的修改'
      default: return '草稿已加载'
    }
  })

  const canUndo = computed(() => historyIndex.value > 0)
  const canRedo = computed(() => historyIndex.value >= 0 && historyIndex.value < history.value.length - 1)

  // ---- Keep selection valid after structural merges ---------------------
  watch(nodes, (next) => {
    if (selectedId.value && !findNode(next, selectedId.value)) {
      selectedId.value = next[0]?.id ?? null
    }
  })

  // ---- Local draft mutation helpers --------------------------------------
  function mutateLocal(mutator: (draft: FieldNode[]) => void, message = '画布已更新') {
    const draftNodes = cloneSchema(localDraft.value.nodes)
    mutator(draftNodes)
    localDraft.value = { ...localDraft.value, nodes: draftNodes }
    recordHistory()
    scheduleCommit()
    return message
  }

  function recordHistory() {
    const snapshot = cloneSchema(localDraft.value)
    history.value = history.value.slice(0, historyIndex.value + 1)
    history.value.push(snapshot)
    if (history.value.length > 60) history.value.shift()
    historyIndex.value = history.value.length - 1
  }

  function scheduleCommit() {
    window.clearTimeout(commitTimer)
    commitTimer = window.setTimeout(() => { void commitDraft() }, 800)
  }

  // ---- Commit: write this tab's batch with opId + baseline version -------
  async function commitDraft(_message?: string) {
    window.clearTimeout(commitTimer)
    if (commitInFlight) {
      commitQueued = true
      return
    }

    const ops: PathOp[] = [
      ...diffMeta(lastCommitted.value, localDraft.value),
      ...diffSchemas(flattenSchema(lastCommitted.value), flattenSchema(localDraft.value)),
    ]
    if (ops.length === 0) {
      syncStatus.value = 'synced'
      syncMessage.value = '无变更'
      return
    }

    // If a previous write failed, keep the same opId and fold new changes in
    // (the original batch is retried, not duplicated).
    const batch: Revision = pendingBatch.value
      ? { ...pendingBatch.value, ops, baseVersion: baselineVersion.value }
      : {
          opId: createId('op'),
          tabId: TAB_ID,
          baseVersion: baselineVersion.value,
          ops,
          createdAt: new Date().toISOString(),
        }

    pendingBatch.value = batch
    commitInFlight = true
    syncStatus.value = 'syncing'
    syncMessage.value = '正在写入修订…'

    const result = await commitRevision(batch)
    commitInFlight = false

    if (result.ok) {
      pendingBatch.value = null
      lastCommitted.value = cloneSchema(localDraft.value)
      syncStatus.value = 'synced'
      syncMessage.value = result.deduped
        ? '同操作号重放，未重复生成修订'
        : '修订已保存'
      refreshShared()
    } else {
      syncStatus.value = 'error'
      syncMessage.value = result.error ?? '写入失败，可重试'
    }

    if (commitQueued) {
      commitQueued = false
      scheduleCommit()
    }
  }

  async function retryCommit() {
    if (!pendingBatch.value || commitInFlight) return
    commitInFlight = true
    syncStatus.value = 'syncing'
    syncMessage.value = '正在重试写入…'
    const result = await commitRevision(pendingBatch.value)
    commitInFlight = false
    if (result.ok) {
      pendingBatch.value = null
      lastCommitted.value = cloneSchema(localDraft.value)
      syncStatus.value = 'synced'
      syncMessage.value = result.deduped ? '同操作号重放，未重复生成修订' : '修订已保存'
      refreshShared()
    } else {
      syncStatus.value = 'error'
      syncMessage.value = result.error ?? '写入失败，可重试'
    }
  }

  /** Replay the current pending batch under the same opId to demonstrate idempotency. */
  async function replaySameOpId(): Promise<{ deduped: boolean }> {
    const batch = pendingBatch.value ?? {
      opId: createId('op'),
      tabId: TAB_ID,
      baseVersion: baselineVersion.value,
      ops: [
        ...diffMeta(lastCommitted.value, localDraft.value),
        ...diffSchemas(flattenSchema(lastCommitted.value), flattenSchema(localDraft.value)),
      ],
      createdAt: new Date().toISOString(),
    }
    const result = await commitRevision(batch)
    if (result.ok) refreshShared()
    return { deduped: !!result.deduped }
  }

  // ---- Cross-tab sync -----------------------------------------------------
  function refreshShared() {
    const s = loadShared()
    if (s.baselineVersion !== baselineVersion.value) {
      rebaseOnto(s.baseline)
    }
    baseline.value = cloneSchema(s.baseline)
    baselineVersion.value = s.baselineVersion
    remoteRevisions.value = s.revisions.filter((r) => r.tabId !== TAB_ID && r.baseVersion === s.baselineVersion)
    revisions.value = cloneSchema(s.revisions)
    schemaRev.value++
  }

  function rebaseOnto(newBaseline: FormSchema) {
    const oldBaseline = baseline.value
    const result = mergeThreeWay(oldBaseline, localDraft.value, newBaseline, { onConflict: 'keep-left' })
    localDraft.value = unflattenSchema(
      result.nodes,
      { title: result.title, description: result.description },
      1,
    )
    // This tab's changes are now relative to the new baseline; reset the
    // commit snapshot so they can be re-committed against it.
    lastCommitted.value = cloneSchema(newBaseline)
    pruneResolutions()
  }

  function pruneResolutions() {
    const active = new Set(rawMerge.value.conflicts.map((c) => c.path))
    Object.keys(resolutions.value).forEach((path) => {
      if (!active.has(path)) delete resolutions.value[path]
    })
  }

  // ---- Conflict resolution -----------------------------------------------
  function applyToLocalDraft(path: string, value: unknown) {
    if (path === 'title') {
      localDraft.value = { ...localDraft.value, title: value as string }
      return
    }
    if (path === 'description') {
      localDraft.value = { ...localDraft.value, description: value as string }
      return
    }
    const parsed = parseNodePath(path)
    if (!parsed) return
    const map = flattenSchema(localDraft.value)
    const fn = map.get(parsed.id)
    if (!fn) return
    map.set(parsed.id, { ...fn, [parsed.prop]: value })
    localDraft.value = unflattenSchema(
      map,
      { title: localDraft.value.title, description: localDraft.value.description },
      1,
    )
  }

  function resolveConflict(path: string, value: unknown) {
    resolutions.value[path] = value
    applyToLocalDraft(path, value)
    schemaRev.value++
  }

  // ---- Dangling ref helpers ----------------------------------------------
  function locateNode(nodeId: string) {
    selectedId.value = nodeId
  }

  function clearNodeCondition(nodeId: string) {
    mutateLocal((draft) => {
      const node = findNode(draft, nodeId)
      if (node) node.condition = undefined
    }, '联动条件已清除')
  }

  // ---- Publish ------------------------------------------------------------
  function publish() {
    if (!canPublish.value) return
    const published = cloneSchema(draft.value)
    const s = publishBaseline(published)
    baseline.value = cloneSchema(s.baseline)
    baselineVersion.value = s.baselineVersion
    remoteRevisions.value = []
    revisions.value = []
    localDraft.value = cloneSchema(published)
    lastCommitted.value = cloneSchema(published)
    resolutions.value = {}
    syncStatus.value = 'synced'
    syncMessage.value = `已发布为基线 v${s.baselineVersion}`
    schemaRev.value++
  }

  // ---- Undo / redo operate on local draft --------------------------------
  function undo() {
    if (!canUndo.value) return
    historyIndex.value -= 1
    applySnapshot(history.value[historyIndex.value])
  }

  function redo() {
    if (!canRedo.value) return
    historyIndex.value += 1
    applySnapshot(history.value[historyIndex.value])
  }

  function applySnapshot(snapshot: FormSchema) {
    localDraft.value = cloneSchema(snapshot)
    if (!findNode(localDraft.value.nodes, selectedId.value ?? '')) {
      selectedId.value = localDraft.value.nodes[0]?.id ?? null
    }
    scheduleCommit()
  }

  function replaceSchema(next: FormSchema) {
    localDraft.value = {
      version: 1,
      title: next.title,
      description: next.description,
      nodes: cloneSchema(next.nodes),
      updatedAt: new Date().toISOString(),
    }
    selectedId.value = localDraft.value.nodes[0]?.id ?? null
    history.value = []
    historyIndex.value = -1
    recordHistory()
    scheduleCommit()
  }

  // ---- Node mutations -----------------------------------------------------
  function addField(type: FieldNode['type'], parentId?: string, index?: number) {
    const node = createField(type)
    mutateLocal((draft) => {
      if (!insertNode(draft, node, parentId, index)) draft.push(node)
    }, `已添加${node.label}`)
    selectedId.value = node.id
  }

  function addNodeInstance(node: FieldNode, parentId?: string, index?: number) {
    const cloned = cloneSchema(node)
    cloned.id = createField(node.type).id
    const normalizeChildren = (children: FieldNode[] = []) => children.forEach((child) => {
      child.id = createField(child.type).id
      normalizeChildren(child.children)
    })
    normalizeChildren(cloned.children)
    mutateLocal((draft) => {
      if (!insertNode(draft, cloned, parentId, index)) draft.push(cloned)
    }, '组件已放入画布')
    selectedId.value = cloned.id
  }

  function updateSelected(patch: Partial<FieldNode>) {
    if (!selectedId.value) return
    mutateLocal((draft) => {
      const node = findNode(draft, selectedId.value!)
      if (node) Object.assign(node, cloneSchema(patch))
    }, '属性已更新')
  }

  function updateValidation(patch: Partial<NonNullable<FieldNode['validation']>>) {
    if (!selectedId.value) return
    mutateLocal((draft) => {
      const node = findNode(draft, selectedId.value!)
      if (node) node.validation = { ...(node.validation ?? { required: false }), ...patch }
    }, '校验规则已更新')
  }

  function updateCondition(patch: Partial<NonNullable<FieldNode['condition']>>) {
    if (!selectedId.value) return
    mutateLocal((draft) => {
      const node = findNode(draft, selectedId.value!)
      if (!node) return
      node.condition = { fieldId: '', operator: 'equals', value: '', ...(node.condition ?? {}), ...patch }
      if (patch.fieldId === '') node.condition = undefined
    }, '联动条件已更新')
  }

  function moveNodeTo(sourceId: string, parentId?: string, index = 0) {
    mutateLocal((draft) => moveNode(draft, sourceId, parentId, index), '节点顺序已调整')
  }

  function removeSelected() {
    if (!selectedId.value) return
    mutateLocal((draft) => removeNode(draft, selectedId.value!), '节点已删除')
    selectedId.value = nodes.value[0]?.id ?? null
  }

  function removeNodeById(id: string) {
    mutateLocal((draft) => removeNode(draft, id), '节点已删除')
    if (selectedId.value === id) selectedId.value = nodes.value[0]?.id ?? null
  }

  function duplicateSelected() {
    if (!selectedId.value) return
    const source = findNode(localDraft.value.nodes, selectedId.value)
    if (!source) return
    const copy = cloneSchema(source)
    copy.id = createField(copy.type).id
    copy.name = `${copy.name}_copy`
    copy.label = `${copy.label} 副本`
    const walk = (items: FieldNode[]) => items.forEach((item) => {
      item.id = createField(item.type).id
      walk(item.children ?? [])
    })
    walk(copy.children ?? [])
    mutateLocal((draft) => draft.push(copy), '节点已复制')
    selectedId.value = copy.id
  }

  function duplicateNodeById(id: string) {
    const source = findNode(localDraft.value.nodes, id)
    if (!source) return
    const copy = cloneSchema(source)
    copy.id = createField(copy.type).id
    copy.name = `${copy.name}_copy`
    copy.label = `${copy.label} 副本`
    const walk = (items: FieldNode[]) => items.forEach((item) => {
      item.id = createField(item.type).id
      walk(item.children ?? [])
    })
    walk(copy.children ?? [])
    mutateLocal((draft) => draft.push(copy), '节点已复制')
    selectedId.value = copy.id
  }

  // ---- Init ---------------------------------------------------------------
  recordHistory()
  subscribe(refreshShared)

  return {
    // state
    title,
    description,
    nodes,
    selectedId,
    selectedNode,
    flatFields,
    schema,
    saveState,
    canUndo,
    canRedo,
    // collab state
    baselineVersion,
    conflicts,
    danglingRefs,
    canPublish,
    syncStatus,
    syncMessage,
    pendingBatch,
    revisions,
    schemaRev,
    tabId: TAB_ID,
    // actions
    addField,
    addNodeInstance,
    updateSelected,
    updateValidation,
    updateCondition,
    moveNodeTo,
    removeSelected,
    removeNodeById,
    duplicateSelected,
    duplicateNodeById,
    undo,
    redo,
    replaceSchema,
    commitDraft,
    retryCommit,
    replaySameOpId,
    resolveConflict,
    locateNode,
    clearNodeCondition,
    publish,
  }
})
