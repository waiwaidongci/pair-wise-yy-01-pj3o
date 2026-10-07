<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import RuntimeField from '../components/RuntimeField.vue'
import { useRevisionStore } from '../stores/revision'
import type { FieldNode, RuntimeValueMap } from '../types/form'
import { evaluateCondition, flattenNodes, validateValue } from '../utils/schema'

const revisionStore = useRevisionStore()
const values = reactive<RuntimeValueMap>({})
const errors = reactive<Record<string, string>>({})
const submitted = ref(false)

// 预览始终以合并结果为准：任一标签页提交修订后这里立即失效重算
const formNodes = computed(() => revisionStore.mergedSchema.nodes)
const formTitle = computed(() => revisionStore.mergedSchema.title)
const formDescription = computed(() => revisionStore.mergedSchema.description)

function applyDefaults(nodes: FieldNode[]) {
  nodes.forEach((node) => {
    if (node.type === 'table') values[node.name] ??= []
    else if (node.defaultValue !== undefined) values[node.name] ??= node.defaultValue
    else if (node.type !== 'group' && node.type !== 'container') values[node.name] ??= ''
    applyDefaults(node.children ?? [])
  })
}
applyDefaults(formNodes.value)

// 联动条件按字段 id 引用，这里把 id 映射到当前填写值
const valuesById = computed<RuntimeValueMap>(() => {
  const map: RuntimeValueMap = {}
  const walk = (nodes: FieldNode[]) => nodes.forEach((node) => {
    map[node.id] = values[node.name]
    walk(node.children ?? [])
  })
  walk(formNodes.value)
  return map
})

// 合并结果一改动：裁剪已移除字段的值与错误、为新字段补默认值，条件与校验立即重算
watch(() => revisionStore.mergeVersion, () => {
  const validNames = new Set(flattenNodes(formNodes.value).map((node) => node.name))
  Object.keys(values).forEach((key) => {
    if (!validNames.has(key)) delete values[key]
  })
  Object.keys(errors).forEach((key) => {
    if (!validNames.has(key)) delete errors[key]
  })
  applyDefaults(formNodes.value)
})

const visibleCount = computed(() => {
  const walk = (nodes: FieldNode[]): number => nodes.reduce((count, node) => {
    if (!evaluateCondition(node.condition, valuesById.value)) return count
    return count + 1 + walk(node.children ?? [])
  }, 0)
  return walk(formNodes.value)
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
    if (!evaluateCondition(node.condition, valuesById.value)) return
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
  if (!validateAll(formNodes.value)) {
    ElMessage.error('表单校验未通过，请检查红色提示')
    return
  }
  ElMessage.success('预览提交成功，数据已生成')
}
</script>

<template>
  <div class="preview-wrap">
    <div class="preview-card">
      <el-alert
        v-if="revisionStore.dangling.length"
        type="warning"
        :closable="false"
        show-icon
        style="margin-bottom: 16px"
      >
        存在 {{ revisionStore.dangling.length }} 处悬空联动条件，对应字段已隐藏；
        请回到设计器的「修订与发布」面板处理后再发布。
      </el-alert>
      <h1>{{ formTitle }}</h1>
      <p>{{ formDescription }}</p>
      <RuntimeField
        v-for="node in formNodes"
        :key="node.id"
        :node="node"
        :values="values"
        :values-by-id="valuesById"
        :errors="errors"
        @update="updateValue"
        @error="updateError"
      />
      <el-button type="primary" size="large" @click="submit">提交表单预览</el-button>
      <div class="summary-box">
        当前可见字段：{{ visibleCount }} 个；校验错误：{{ Object.keys(errors).length }} 个。
        <span v-if="submitted">最近一次提交已触发完整条件显隐与校验流程。</span>
        <span>数据基于基线 v{{ revisionStore.baseline.version }} + {{ revisionStore.revisionCount }} 条修订的合并结果。</span>
      </div>
    </div>
  </div>
</template>
