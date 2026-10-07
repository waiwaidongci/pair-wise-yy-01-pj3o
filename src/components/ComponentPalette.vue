<script setup lang="ts">
import { Calendar, Collection, Document, Grid, Menu, SetUp } from '@element-plus/icons-vue'
import type { FieldNode } from '../types/form'
import { typeLabel } from '../utils/schema'

const components: Array<{ type: FieldNode['type']; icon: typeof Document; description: string }> = [
  { type: 'input', icon: EditPen, description: '单行文本与格式校验' },
  { type: 'select', icon: Menu, description: '下拉选项与条件联动' },
  { type: 'date', icon: Calendar, description: '日期选择与范围约束' },
  { type: 'table', icon: Grid, description: '多行明细数据录入' },
  { type: 'group', icon: Collection, description: '可嵌套的字段分组' },
  { type: 'container', icon: SetUp, description: '自定义业务区域' },
]

import { EditPen } from '@element-plus/icons-vue'

function dragStart(event: DragEvent, type: FieldNode['type']) {
  event.dataTransfer?.setData('application/x-form-field', type)
  event.dataTransfer?.setData('text/plain', type)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'
}
</script>

<template>
  <aside class="side-panel">
    <div class="panel-head">
      <span class="panel-title">组件库</span>
      <span class="muted">拖到画布</span>
    </div>
    <div class="panel-scroll">
      <div class="component-list">
        <div
          v-for="item in components"
          :key="item.type"
          class="component-card"
          draggable="true"
          @dragstart="dragStart($event, item.type)"
        >
          <el-icon size="19"><component :is="item.icon" /></el-icon>
          <div class="component-meta">
            <strong>{{ typeLabel(item.type) }}</strong>
            <span>{{ item.description }}</span>
          </div>
        </div>
      </div>
    </div>
  </aside>
</template>
