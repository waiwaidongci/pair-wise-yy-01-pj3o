<script setup lang="ts">
import { ref } from 'vue'
import { useDropZone } from '@vueuse/core'
import { RefreshLeft, RefreshRight, Upload } from '@element-plus/icons-vue'
import { useDesignerStore } from '../stores/designer'
import { useRevisionStore } from '../stores/revision'
import type { FieldNode } from '../types/form'
import BuilderNode from './BuilderNode.vue'

const emit = defineEmits<{ importJson: []; showRevisions: [] }>()
const store = useDesignerStore()
const revisionStore = useRevisionStore()
const canvasRef = ref<HTMLElement | null>(null)

useDropZone(canvasRef, {
  dataTypes: ['application/x-form-field'],
  onDrop: (_files, event) => {
    const dragEvent = event as DragEvent
    const type = dragEvent.dataTransfer?.getData('application/x-form-field') as FieldNode['type']
    if (type) store.addField(type)
  },
})

function handleDrop(event: DragEvent) {
  event.preventDefault()
  const sourceId = event.dataTransfer?.getData('application/x-form-node')
  if (sourceId) {
    store.moveNodeTo(sourceId, undefined, store.nodes.length)
    return
  }
  const type = event.dataTransfer?.getData('application/x-form-field') as FieldNode['type']
  if (type) store.addField(type)
}
</script>

<template>
  <section class="canvas-panel">
    <div class="canvas-toolbar">
      <div class="toolbar-row">
        <el-button-group>
          <el-button :disabled="!store.canUndo" @click="store.undo">
            <el-icon><RefreshLeft /></el-icon>
            撤销
          </el-button>
          <el-button :disabled="!store.canRedo" @click="store.redo">
            <el-icon><RefreshRight /></el-icon>
            重做
          </el-button>
        </el-button-group>
        <el-divider direction="vertical" />
        <el-tag size="small" effect="plain">基线 v{{ revisionStore.baseline.version }}</el-tag>
        <el-tag size="small" type="info" effect="light">修订 {{ revisionStore.revisionCount }}</el-tag>
        <el-tag v-if="revisionStore.conflicts.length" size="small" type="danger" effect="light">
          冲突 {{ revisionStore.conflicts.length }}
        </el-tag>
        <el-tag v-if="revisionStore.dangling.length" size="small" type="warning" effect="light">
          悬空 {{ revisionStore.dangling.length }}
        </el-tag>
        <el-tag v-if="store.remotePending" size="small" type="warning" effect="plain">远端有更新</el-tag>
        <el-divider direction="vertical" />
        <span class="muted">拖拽节点可排序或进入分组/容器</span>
      </div>
      <div class="toolbar-row">
        <el-button type="primary" plain @click="emit('showRevisions')">修订与发布</el-button>
        <el-button type="primary" plain @click="emit('importJson')">
          <el-icon><Upload /></el-icon>
          导入 JSON
        </el-button>
      </div>
    </div>
    <div class="canvas-scroll">
      <div
        ref="canvasRef"
        class="form-canvas"
        @dragover.prevent
        @drop="handleDrop"
      >
        <el-input v-model="store.title" class="form-title-input" @change="store.commitDraft('标题已更新')" />
        <el-input
          v-model="store.description"
          type="textarea"
          :rows="2"
          resize="none"
          style="margin-bottom: 20px"
          @change="store.commitDraft('说明已更新')"
        />
        <BuilderNode
          v-for="(node, index) in store.nodes"
          :key="node.id"
          :node="node"
          :index="index"
        />
        <div v-if="!store.nodes.length" class="empty-canvas">
          <strong>画布还是空的</strong>
          从左侧组件库拖入第一个业务字段
        </div>
      </div>
    </div>
  </section>
</template>
