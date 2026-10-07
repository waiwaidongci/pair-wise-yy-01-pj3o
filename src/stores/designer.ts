import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { FieldNode, FormSchema } from '../types/form'
import { cloneSchema, createField, findNode, insertNode, moveNode, removeNode } from '../utils/schema'
import { diffSchemas } from '../utils/revision'
import { useRevisionStore } from './revision'

interface WorkingCopy {
  title: string
  description: string
  nodes: FieldNode[]
}

function snapshotJson(snapshot: WorkingCopy): string {
  return JSON.stringify({ title: snapshot.title, description: snapshot.description, nodes: snapshot.nodes })
}

function toSchema(snapshot: WorkingCopy): FormSchema {
  return { version: 1, ...cloneSchema(snapshot), updatedAt: new Date().toISOString() }
}

export const useDesignerStore = defineStore('designer', () => {
  const revisionStore = useRevisionStore()

  const initial = revisionStore.mergedSchema
  const title = ref(initial.title)
  const description = ref(initial.description)
  const nodes = ref<FieldNode[]>(cloneSchema(initial.nodes))
  const selectedId = ref<string | null>(nodes.value[0]?.id ?? null)
  const history = ref<FormSchema[]>([])
  const historyIndex = ref(-1)
  const saveState = ref('草稿已加载')
  /** 本侧有未提交编辑时远端又有更新，提交时会自动合并 */
  const remotePending = ref(false)
  /** 最近一次已提交进草稿文档的工作副本（diff 基准） */
  const syncedJson = ref(snapshotJson({ title: title.value, description: description.value, nodes: nodes.value }))
  let commitTimer: number | undefined

  const selectedNode = computed(() => selectedId.value ? findNode(nodes.value, selectedId.value) : undefined)
  const flatFields = computed(() => {
    const walk = (items: FieldNode[]): FieldNode[] => items.flatMap((item) => [item, ...walk(item.children ?? [])])
    return walk(nodes.value).filter((item) => ['input', 'select', 'date'].includes(item.type))
  })
  const schema = computed<FormSchema>(() => toSchema({ title: title.value, description: description.value, nodes: nodes.value }))
  const dirty = computed(() => snapshotJson({ title: title.value, description: description.value, nodes: nodes.value }) !== syncedJson.value)
  const canUndo = computed(() => historyIndex.value > 0)
  const canRedo = computed(() => historyIndex.value >= 0 && historyIndex.value < history.value.length - 1)

  function currentSnapshot(): WorkingCopy {
    return { title: title.value, description: description.value, nodes: cloneSchema(nodes.value) }
  }

  function recordHistory() {
    const snapshot = toSchema({ title: title.value, description: description.value, nodes: nodes.value })
    history.value = history.value.slice(0, historyIndex.value + 1)
    history.value.push(snapshot)
    if (history.value.length > 60) history.value.shift()
    historyIndex.value = history.value.length - 1
  }

  function scheduleCommit() {
    saveState.value = '正在提交修订...'
    window.clearTimeout(commitTimer)
    commitTimer = window.setTimeout(flushCommit, 500)
  }

  /** 把工作副本与上次提交点做 diff，作为一个修订批次提交（携带操作号与基线版本） */
  function flushCommit() {
    window.clearTimeout(commitTimer)
    const base = JSON.parse(syncedJson.value) as WorkingCopy
    const current = currentSnapshot()
    const changes = diffSchemas(toSchema(base), toSchema(current))
    if (!changes.length) return
    const revision = revisionStore.submitChanges(changes)
    if (!revision) return
    syncedJson.value = snapshotJson(current)
    remotePending.value = false
    saveState.value = revisionStore.persistError
      ? '写入失败，原批次可重试'
      : `已提交修订 ${revision.opId.slice(-6)}（基线 v${revision.baseVersion}）`
  }

  function commitDraft(message = '变更已保存') {
    recordHistory()
    saveState.value = message
    flushCommit()
  }

  function mutate(mutator: (draft: FieldNode[]) => void, message = '画布已更新') {
    const draft = cloneSchema(nodes.value)
    mutator(draft)
    nodes.value = draft
    recordHistory()
    saveState.value = message
    scheduleCommit()
  }

  /** 合并结果变化时：本侧没有未提交编辑就直接采纳，否则等提交时自动合并 */
  function adoptMerged() {
    const mergedSchema = revisionStore.mergedSchema
    const next: WorkingCopy = {
      title: mergedSchema.title,
      description: mergedSchema.description,
      nodes: cloneSchema(mergedSchema.nodes),
    }
    const nextJson = snapshotJson(next)
    syncedJson.value = nextJson
    if (nextJson === snapshotJson({ title: title.value, description: description.value, nodes: nodes.value })) return
    title.value = next.title
    description.value = next.description
    nodes.value = next.nodes
    if (!findNode(nodes.value, selectedId.value ?? '')) selectedId.value = nodes.value[0]?.id ?? null
  }

  watch(() => revisionStore.mergeVersion, () => {
    if (dirty.value) {
      remotePending.value = true
      return
    }
    remotePending.value = false
    adoptMerged()
  })

  watch(() => revisionStore.persistError, (error) => {
    if (error) saveState.value = '写入失败，原批次可重试'
  })

  function addField(type: FieldNode['type'], parentId?: string, index?: number) {
    const node = createField(type)
    mutate((draft) => {
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
    mutate((draft) => insertNode(draft, cloned, parentId, index), '组件已放入画布')
    selectedId.value = cloned.id
  }

  function updateSelected(patch: Partial<FieldNode>) {
    if (!selectedId.value) return
    mutate((draft) => {
      const node = findNode(draft, selectedId.value!)
      if (node) Object.assign(node, cloneSchema(patch))
    }, '属性已更新')
  }

  function updateValidation(patch: Partial<NonNullable<FieldNode['validation']>>) {
    if (!selectedId.value) return
    mutate((draft) => {
      const node = findNode(draft, selectedId.value!)
      if (node) node.validation = { ...(node.validation ?? { required: false }), ...patch }
    }, '校验规则已更新')
  }

  function updateCondition(patch: Partial<NonNullable<FieldNode['condition']>>) {
    if (!selectedId.value) return
    mutate((draft) => {
      const node = findNode(draft, selectedId.value!)
      if (!node) return
      node.condition = { fieldId: '', operator: 'equals', value: '', ...(node.condition ?? {}), ...patch }
      if (patch.fieldId === '') node.condition = undefined
    }, '联动条件已更新')
  }

  function moveNodeTo(sourceId: string, parentId?: string, index = 0) {
    mutate((draft) => moveNode(draft, sourceId, parentId, index), '节点顺序已调整')
  }

  function removeSelected() {
    if (!selectedId.value) return
    mutate((draft) => removeNode(draft, selectedId.value!), '节点已删除')
    selectedId.value = nodes.value[0]?.id ?? null
  }

  function removeNodeById(id: string) {
    mutate((draft) => removeNode(draft, id), '节点已删除')
    if (selectedId.value === id) selectedId.value = nodes.value[0]?.id ?? null
  }

  function duplicateSelected() {
    if (!selectedId.value) return
    duplicateNodeById(selectedId.value)
  }

  function duplicateNodeById(id: string) {
    const source = findNode(nodes.value, id)
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
    mutate((draft) => draft.push(copy), '节点已复制')
    selectedId.value = copy.id
  }

  function selectNodeById(id: string) {
    if (findNode(nodes.value, id)) selectedId.value = id
  }

  /** 清除指定字段上的联动条件（用于修复悬空引用） */
  function clearConditionOf(id: string) {
    mutate((draft) => {
      const node = findNode(draft, id)
      if (node) node.condition = undefined
    }, '已清除悬空联动条件')
  }

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
    title.value = snapshot.title
    description.value = snapshot.description
    nodes.value = cloneSchema(snapshot.nodes)
    if (!findNode(nodes.value, selectedId.value ?? '')) selectedId.value = nodes.value[0]?.id ?? null
    scheduleCommit()
  }

  function replaceSchema(next: FormSchema) {
    title.value = next.title
    description.value = next.description
    nodes.value = cloneSchema(next.nodes)
    selectedId.value = nodes.value[0]?.id ?? null
    history.value = []
    historyIndex.value = -1
    recordHistory()
    flushCommit()
  }

  recordHistory()

  return {
    title,
    description,
    nodes,
    selectedId,
    selectedNode,
    flatFields,
    schema,
    saveState,
    dirty,
    remotePending,
    canUndo,
    canRedo,
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
    selectNodeById,
    clearConditionOf,
    undo,
    redo,
    replaceSchema,
    commitDraft,
    flushCommit,
    mutate,
  }
})
