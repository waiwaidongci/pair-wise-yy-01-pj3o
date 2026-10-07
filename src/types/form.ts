export type FieldType = 'input' | 'select' | 'date' | 'table' | 'group' | 'container'
export type ConditionOperator = 'equals' | 'notEquals' | 'contains' | 'greaterThan' | 'lessThan'

export interface TableColumn {
  key: string
  label: string
  type?: 'text' | 'number' | 'date'
}

export interface ValidationRule {
  required: boolean
  minLength?: number
  maxLength?: number
  pattern?: string
  min?: number
  max?: number
  message?: string
}

export interface VisibilityCondition {
  fieldId: string
  operator: ConditionOperator
  value: string | number
}

export interface FieldNode {
  id: string
  type: FieldType
  label: string
  name: string
  placeholder?: string
  defaultValue?: unknown
  options?: string[]
  columns?: TableColumn[]
  validation?: ValidationRule
  condition?: VisibilityCondition
  children?: FieldNode[]
}

export interface FormSchema {
  version: 1
  title: string
  description: string
  nodes: FieldNode[]
  updatedAt: string
}

export interface RuntimeValueMap {
  [key: string]: unknown
}
