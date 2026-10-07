<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import RuntimeField from '../components/RuntimeField.vue'
import { useDesignerStore } from '../stores/designer'
import type { FieldNode, RuntimeValueMap } from '../types/form'
import { evaluateCondition, validateValue } from '../utils/schema'

const store = useDesignerStore()
const values = reactive<RuntimeValueMap>({})
const errors = reactive<Record<string, string>>({})
const submitted = ref(false)

function applyDefaults(nodes: FieldNode[]) {
  nodes.forEach((node) => {
    if (node.type === 'table') values[node.name] = []
    else if (node.defaultValue !== undefined) values[node.name] = node.defaultValue
    else if (node.type === 'select' || node.type === 'date') values[node.name] = ''
    else if (node.type !== 'group' && node.type !== 'container') values[node.name] = ''
    applyDefaults(node.children ?? [])
  })
}
applyDefaults(store.nodes)

const visibleCount = computed(() => {
  const walk = (nodes: FieldNode[]): number => nodes.reduce((count, node) => {
    if (!evaluateCondition(node.condition, values)) return count
    return count + 1 + walk(node.children ?? [])
  }, 0)
  return walk(store.nodes)
})

function updateValue(name: string, value: unknown) {
  values[name] = value
}

function updateError(name: string, error: string) {
  if (error) errors[name] = error
  else delete errors[name]
}

function validateAll(nodes: FieldNode[]) {
  let valid = true
  nodes.forEach((node) => {
    if (!evaluateCondition(node.condition, values)) return
    if (node.type !== 'group' && node.type !== 'container') {
      const error = validateValue(values[node.name], node.validation)
      if (error) {
        errors[node.name] = error
        valid = false
      }
    }
    if (!validateAll(node.children ?? [])) valid = false
  })
  return valid
}

function submit() {
  Object.keys(errors).forEach((key) => delete errors[key])
  submitted.value = true
  if (!validateAll(store.nodes)) {
    ElMessage.error('表单校验未通过，请检查红色提示')
    return
  }
  ElMessage.success('预览提交成功，数据已生成')
}
</script>

<template>
  <div class="preview-wrap">
    <div class="preview-card">
      <h1>{{ store.title }}</h1>
      <p>{{ store.description }}</p>
      <RuntimeField
        v-for="node in store.nodes"
        :key="node.id"
        :node="node"
        :values="values"
        :errors="errors"
        @update="updateValue"
        @error="updateError"
      />
      <el-button type="primary" size="large" @click="submit">提交表单预览</el-button>
      <div class="summary-box">
        当前可见字段：{{ visibleCount }} 个；校验错误：{{ Object.keys(errors).length }} 个。
        <span v-if="submitted">最近一次提交已触发完整条件显隐与校验流程。</span>
      </div>
    </div>
  </div>
</template>
