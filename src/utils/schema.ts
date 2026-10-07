import type { FieldNode, RuntimeValueMap, ValidationRule, VisibilityCondition } from '../types/form'
import { createId } from './id'

export function cloneSchema<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function createField(type: FieldNode['type']): FieldNode {
  const base: FieldNode = {
    id: createId(type),
    type,
    label: type === 'group' ? '基本信息' : type === 'container' ? '业务区域' : `新建${typeLabel(type)}`,
    name: `${type}_${Math.random().toString(36).slice(2, 6)}`,
    validation: { required: false },
  }
  if (type === 'input') base.placeholder = '请输入内容'
  if (type === 'select') {
    base.placeholder = '请选择'
    base.options = ['选项 A', '选项 B', '选项 C']
  }
  if (type === 'date') base.placeholder = '请选择日期'
  if (type === 'table') {
    base.columns = [
      { key: 'name', label: '项目名称', type: 'text' },
      { key: 'amount', label: '金额', type: 'number' },
      { key: 'date', label: '日期', type: 'date' },
    ]
    base.children = []
  }
  if (type === 'group' || type === 'container') base.children = []
  return base
}

export function typeLabel(type: FieldNode['type']): string {
  return {
    input: '输入框',
    select: '选择器',
    date: '日期',
    table: '表格',
    group: '分组',
    container: '自定义容器',
  }[type]
}

export function flattenNodes(nodes: FieldNode[]): FieldNode[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children ?? [])])
}

export function findNode(nodes: FieldNode[], id: string): FieldNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node
    const child = findNode(node.children ?? [], id)
    if (child) return child
  }
  return undefined
}

export function findParent(nodes: FieldNode[], id: string, parent?: FieldNode): FieldNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return parent
    const found = findParent(node.children ?? [], id, node)
    if (found !== undefined) return found
  }
  return undefined
}

export function removeNode(nodes: FieldNode[], id: string): boolean {
  const index = nodes.findIndex((node) => node.id === id)
  if (index >= 0) {
    nodes.splice(index, 1)
    return true
  }
  return nodes.some((node) => removeNode(node.children ?? [], id))
}

export function insertNode(nodes: FieldNode[], node: FieldNode, parentId?: string, index?: number): boolean {
  if (!parentId) {
    nodes.splice(index ?? nodes.length, 0, node)
    return true
  }
  const parent = findNode(nodes, parentId)
  if (!parent) return false
  if (!parent.children) parent.children = []
  parent.children.splice(index ?? parent.children.length, 0, node)
  return true
}

export function moveNode(nodes: FieldNode[], sourceId: string, targetParentId?: string, targetIndex = 0): void {
  const source = findNode(nodes, sourceId)
  if (!source) return
  const cloned = cloneSchema(source)
  removeNode(nodes, sourceId)
  if (targetParentId && !findNode(nodes, targetParentId)) {
    nodes.push(cloned)
    return
  }
  insertNode(nodes, cloned, targetParentId, targetIndex)
}

export function evaluateCondition(condition: VisibilityCondition | undefined, values: RuntimeValueMap): boolean {
  if (!condition?.fieldId) return true
  const current = values[condition.fieldId]
  const compare = condition.value
  switch (condition.operator) {
    case 'equals': return String(current ?? '') === String(compare)
    case 'notEquals': return String(current ?? '') !== String(compare)
    case 'contains': return String(current ?? '').includes(String(compare))
    case 'greaterThan': return Number(current) > Number(compare)
    case 'lessThan': return Number(current) < Number(compare)
    default: return true
  }
}

export function validateValue(value: unknown, rule?: ValidationRule): string | null {
  if (!rule) return null
  const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
  if (rule.required && empty) return rule.message || '此项为必填项'
  if (empty) return null
  const text = String(value)
  if (rule.minLength !== undefined && text.length < rule.minLength) return rule.message || `至少输入 ${rule.minLength} 个字符`
  if (rule.maxLength !== undefined && text.length > rule.maxLength) return rule.message || `最多输入 ${rule.maxLength} 个字符`
  if (rule.min !== undefined && Number(value) < rule.min) return rule.message || `不能小于 ${rule.min}`
  if (rule.max !== undefined && Number(value) > rule.max) return rule.message || `不能大于 ${rule.max}`
  if (rule.pattern) {
    try {
      if (!new RegExp(rule.pattern).test(text)) return rule.message || '格式不符合要求'
    } catch {
      return '校验正则表达式无效'
    }
  }
  return null
}

export function createStarterSchema() {
  const name = createField('input')
  name.label = '申请人姓名'
  name.name = 'applicantName'
  name.validation = { required: true, minLength: 2, message: '请输入至少 2 个字符的姓名' }

  const type = createField('select')
  type.label = '申请类型'
  type.name = 'requestType'
  type.options = ['差旅报销', '采购申请', '合同审批', '其他']
  type.validation = { required: true }

  const amount = createField('input')
  amount.label = '申请金额'
  amount.name = 'amount'
  amount.placeholder = '请输入金额'
  amount.validation = { required: true, pattern: '^\\d+(\\.\\d{1,2})?$', message: '请输入合法金额，最多两位小数' }
  amount.condition = { fieldId: type.id, operator: 'notEquals', value: '其他' }

  const date = createField('date')
  date.label = '期望日期'
  date.name = 'expectedDate'
  date.validation = { required: true }

  const reason = createField('container')
  reason.label = '申请说明'
  reason.name = 'reasonSection'
  const detail = createField('input')
  detail.label = '补充说明'
  detail.name = 'detail'
  detail.placeholder = '请说明申请背景与用途'
  detail.validation = { required: true, minLength: 5 }
  reason.children = [detail]

  const table = createField('table')
  table.label = '费用明细'
  table.name = 'expenses'
  table.condition = { fieldId: type.id, operator: 'equals', value: '差旅报销' }

  return {
    version: 1 as const,
    title: '费用申请审批表',
    description: '请完整填写申请信息，带 * 的字段为必填项。',
    nodes: [name, type, amount, date, reason, table],
    updatedAt: new Date().toISOString(),
  }
}
