<script setup lang="ts">
import { computed } from 'vue'
import { CopyDocument, Delete } from '@element-plus/icons-vue'
import type { FieldNode } from '../types/form'
import { useDesignerStore } from '../stores/designer'

const props = defineProps<{
  node: FieldNode
  index: number
  parentId?: string
}>()

const store = useDesignerStore()
const selected = computed(() => store.selectedId === props.node.id)
const isContainer = computed(() => props.node.type === 'group' || props.node.type === 'container')

function selectNode() {
  store.selectedId = props.node.id
}

function allowDrop(event: DragEvent) {
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

function dropBefore(event: DragEvent) {
  allowDrop(event)
  const sourceId = event.dataTransfer?.getData('application/x-form-node')
  if (sourceId) {
    store.moveNodeTo(sourceId, props.parentId, props.index)
    return
  }
  const type = event.dataTransfer?.getData('application/x-form-field') as FieldNode['type']
  if (type) store.addField(type, props.parentId, props.index)
}

function dropInside(event: DragEvent) {
  allowDrop(event)
  const sourceId = event.dataTransfer?.getData('application/x-form-node')
  if (sourceId && sourceId !== props.node.id) {
    store.moveNodeTo(sourceId, props.node.id, props.node.children?.length ?? 0)
    return
  }
  const type = event.dataTransfer?.getData('application/x-form-field') as FieldNode['type']
  if (type) store.addField(type, props.node.id)
}

function nodeDragStart(event: DragEvent) {
  event.stopPropagation()
  event.dataTransfer?.setData('application/x-form-node', props.node.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}
</script>

<template>
  <div
    class="builder-node"
    :class="{ selected }"
    draggable="true"
    @click.stop="selectNode"
    @dragstart="nodeDragStart"
  >
    <div class="drop-line" @dragover="allowDrop" @drop="dropBefore" />
    <div class="node-toolbar">
      <el-tag size="small" effect="plain">{{ node.type }}</el-tag>
      <el-button size="small" circle text @click.stop="store.duplicateNodeById(node.id)">
        <el-icon><CopyDocument /></el-icon>
      </el-button>
      <el-button size="small" circle text type="danger" @click.stop="store.removeNodeById(node.id)">
        <el-icon><Delete /></el-icon>
      </el-button>
    </div>
    <div class="node-body">
      <div class="node-label">
        {{ node.label }}
        <span v-if="node.validation?.required" class="required-dot">*</span>
        <el-tag v-if="node.condition?.fieldId" class="condition-tag" size="small" type="warning" effect="light">
          联动
        </el-tag>
      </div>

      <el-input v-if="node.type === 'input'" :placeholder="node.placeholder" disabled />
      <el-select v-else-if="node.type === 'select'" :placeholder="node.placeholder" style="width: 100%" disabled>
        <el-option v-for="option in node.options" :key="option" :label="option" :value="option" />
      </el-select>
      <el-date-picker v-else-if="node.type === 'date'" :placeholder="node.placeholder" disabled style="width: 100%" />
      <div v-else-if="node.type === 'table'" class="table-mock">
        <table style="width: 100%; border-collapse: collapse">
          <thead>
            <tr><th v-for="column in node.columns" :key="column.key">{{ column.label }}</th></tr>
          </thead>
          <tbody>
            <tr><td v-for="column in node.columns" :key="column.key">{{ column.label }}</td></tr>
          </tbody>
        </table>
      </div>
      <div
        v-else
        :class="node.type === 'container' ? 'container-shell' : 'group-shell'"
        @dragover="allowDrop"
        @drop="dropInside"
      >
        <div class="container-title">{{ node.type === 'container' ? '自定义容器内容' : '分组内容' }}</div>
        <BuilderNode
          v-for="(child, childIndex) in node.children"
          :key="child.id"
          :node="child"
          :index="childIndex"
          :parent-id="node.id"
        />
        <div v-if="!node.children?.length" class="field-empty">将组件拖到这里完成嵌套布局</div>
      </div>
    </div>
  </div>
</template>
