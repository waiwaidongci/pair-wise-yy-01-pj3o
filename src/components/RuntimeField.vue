<script setup lang="ts">
import { computed, ref } from 'vue'
import { Delete, Plus } from '@element-plus/icons-vue'
import type { FieldNode, RuntimeValueMap } from '../types/form'
import { evaluateCondition, validateValue } from '../utils/schema'

const props = defineProps<{
  node: FieldNode
  values: RuntimeValueMap
  /** 字段 id → 当前填写值，用于联动条件求值（条件按字段 id 引用） */
  valuesById: RuntimeValueMap
  errors: Record<string, string>
}>()

const emit = defineEmits<{
  update: [fieldName: string, value: unknown]
  error: [fieldName: string, error: string]
}>()

const visible = computed(() => evaluateCondition(props.node.condition, props.valuesById))
const isContainer = computed(() => props.node.type === 'group' || props.node.type === 'container')
const tableRows = computed(() => {
  const value = props.values[props.node.name]
  return Array.isArray(value) ? value as Array<Record<string, unknown>> : []
})

function update(value: unknown) {
  emit('update', props.node.name, value)
  const error = validateValue(value, props.node.validation)
  emit('error', props.node.name, error ?? '')
}

function addTableRow() {
  const next = [...tableRows.value, Object.fromEntries((props.node.columns ?? []).map((column) => [column.key, '']))]
  update(next)
}

function updateTableValue(rowIndex: number, key: string, value: unknown) {
  const next = tableRows.value.map((row, index) => index === rowIndex ? { ...row, [key]: value } : { ...row })
  update(next)
}

function removeTableRow(rowIndex: number) {
  update(tableRows.value.filter((_, index) => index !== rowIndex))
}
</script>

<template>
  <template v-if="visible">
    <div v-if="isContainer" class="runtime-container">
      <div class="runtime-label">{{ node.label }}</div>
      <RuntimeField
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :values="values"
        :values-by-id="valuesById"
        :errors="errors"
        @update="(name, value) => emit('update', name, value)"
        @error="(name, error) => emit('error', name, error)"
      />
    </div>
    <div v-else class="runtime-field">
      <div class="runtime-label">
        {{ node.label }}
        <span v-if="node.validation?.required" class="required-dot">*</span>
      </div>
      <el-input
        v-if="node.type === 'input'"
        :model-value="values[node.name] as string"
        :placeholder="node.placeholder"
        @update:model-value="update"
      />
      <el-select
        v-else-if="node.type === 'select'"
        :model-value="values[node.name]"
        :placeholder="node.placeholder"
        style="width: 100%"
        @update:model-value="update"
      >
        <el-option v-for="option in node.options" :key="option" :label="option" :value="option" />
      </el-select>
      <el-date-picker
        v-else-if="node.type === 'date'"
        :model-value="values[node.name] as string"
        type="date"
        value-format="YYYY-MM-DD"
        :placeholder="node.placeholder"
        style="width: 100%"
        @update:model-value="update"
      />
      <div v-else-if="node.type === 'table'" class="runtime-table">
        <div class="runtime-table-row head">
          <div v-for="column in node.columns" :key="column.key" class="runtime-table-cell">{{ column.label }}</div>
          <div class="runtime-table-cell" style="max-width: 70px">操作</div>
        </div>
        <div v-for="(row, rowIndex) in tableRows" :key="rowIndex" class="runtime-table-row">
          <div v-for="column in node.columns" :key="column.key" class="runtime-table-cell">
            <el-input
              :model-value="row[column.key] as string"
              size="small"
              @update:model-value="updateTableValue(rowIndex, column.key, $event)"
            />
          </div>
          <div class="runtime-table-cell" style="max-width: 70px">
            <el-button link type="danger" @click="removeTableRow(rowIndex)">
              <el-icon><Delete /></el-icon>
            </el-button>
          </div>
        </div>
        <div style="padding: 8px">
          <el-button size="small" plain @click="addTableRow">
            <el-icon><Plus /></el-icon>
            添加明细
          </el-button>
        </div>
      </div>
      <div v-if="errors[node.name]" class="error-text">{{ errors[node.name] }}</div>
    </div>
  </template>
</template>
