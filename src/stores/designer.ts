import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { FieldNode, FormSchema } from '../types/form'
import { cloneSchema, createField, createStarterSchema, findNode, insertNode, moveNode, removeNode } from '../utils/schema'

const STORAGE_KEY = 'formcraft-schema-v1'

function loadInitialSchema(): FormSchema {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as FormSchema
  } catch {
    // Ignore invalid local drafts and fall back to the demo form.
  }
  return createStarterSchema()
}

export const useDesignerStore = defineStore('designer', () => {
  const initial = loadInitialSchema()
  const title = ref(initial.title)
  const description = ref(initial.description)
  const nodes = ref<FieldNode[]>(initial.nodes)
  const selectedId = ref<string | null>(nodes.value[0]?.id ?? null)
  const history = ref<FormSchema[]>([])
  const historyIndex = ref(-1)
  const saveState = ref('草稿已加载')
  let saveTimer: number | undefined

  const selectedNode = computed(() => selectedId.value ? findNode(nodes.value, selectedId.value) : undefined)
  const flatFields = computed(() => {
    const walk = (items: FieldNode[]): FieldNode[] => items.flatMap((item) => [item, ...walk(item.children ?? [])])
    return walk(nodes.value).filter((item) => ['input', 'select', 'date'].includes(item.type))
  })
  const schema = computed<FormSchema>(() => ({
    version: 1,
    title: title.value,
    description: description.value,
    nodes: cloneSchema(nodes.value),
    updatedAt: new Date().toISOString(),
  }))
  const canUndo = computed(() => historyIndex.value > 0)
  const canRedo = computed(() => historyIndex.value >= 0 && historyIndex.value < history.value.length - 1)

  function scheduleSave() {
    saveState.value = '正在保存...'
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(schema.value))
      saveState.value = `已保存 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
    }, 350)
  }

  function recordHistory() {
    const snapshot = cloneSchema(schema.value)
    history.value = history.value.slice(0, historyIndex.value + 1)
    history.value.push(snapshot)
    if (history.value.length > 60) history.value.shift()
    historyIndex.value = history.value.length - 1
  }

  function commitDraft(message = '变更已保存') {
    recordHistory()
    saveState.value = message
    scheduleSave()
  }

  function mutate(mutator: (draft: FieldNode[]) => void, message = '画布已更新') {
    const draft = cloneSchema(nodes.value)
    mutator(draft)
    nodes.value = draft
    commitDraft(message)
  }

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
    const source = findNode(nodes.value, selectedId.value)
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
    scheduleSave()
  }

  function replaceSchema(next: FormSchema) {
    title.value = next.title
    description.value = next.description
    nodes.value = next.nodes
    selectedId.value = nodes.value[0]?.id ?? null
    history.value = []
    historyIndex.value = -1
    recordHistory()
    scheduleSave()
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
    undo,
    redo,
    replaceSchema,
    commitDraft,
    mutate,
  }
})
