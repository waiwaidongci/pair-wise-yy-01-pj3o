<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download } from '@element-plus/icons-vue'
import ComponentPalette from '../components/ComponentPalette.vue'
import DesignerCanvas from '../components/DesignerCanvas.vue'
import PropertyPanel from '../components/PropertyPanel.vue'
import RevisionPanel from '../components/RevisionPanel.vue'
import { useDesignerStore } from '../stores/designer'
import { useRevisionStore } from '../stores/revision'
import type { FormSchema } from '../types/form'

const store = useDesignerStore()
const revisionStore = useRevisionStore()
const importVisible = ref(false)
const importText = ref('')
const revisionsVisible = ref(false)

onMounted(() => {
  if (revisionStore.migratedFromLegacy) {
    revisionStore.migratedFromLegacy = false
    ElMessage.success('检测到旧版本地草稿，已迁移为基线 v1，原内容完整保留')
  }
})

function exportJson() {
  const content = JSON.stringify(store.schema, null, 2)
  navigator.clipboard?.writeText(content)
  ElMessage.success('Schema JSON 已复制到剪贴板')
}

async function showExport() {
  const content = JSON.stringify(store.schema, null, 2)
  await ElMessageBox.alert(`<pre style="max-height:360px;overflow:auto;white-space:pre-wrap">${content.replace(/</g, '&lt;')}</pre>`, 'Schema JSON', {
    dangerouslyUseHTMLString: true,
    confirmButtonText: '关闭',
  })
}

function applyImport() {
  try {
    const parsed = JSON.parse(importText.value) as FormSchema
    if (!parsed.title || !Array.isArray(parsed.nodes)) throw new Error('Schema 缺少 title 或 nodes')
    store.replaceSchema(parsed)
    importVisible.value = false
    importText.value = ''
    ElMessage.success('Schema 导入成功')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'JSON 格式错误')
  }
}
</script>

<template>
  <div class="designer-grid">
    <ComponentPalette />
    <DesignerCanvas @import-json="importVisible = true" @show-revisions="revisionsVisible = true" />
    <PropertyPanel />
  </div>

  <el-drawer v-model="revisionsVisible" title="修订与发布" size="420px">
    <RevisionPanel @close="revisionsVisible = false" />
  </el-drawer>

  <div style="position: fixed; right: 320px; bottom: 16px; z-index: 10">
    <el-button type="primary" @click="showExport">
      <el-icon><Download /></el-icon>
      查看 / 导出 Schema
    </el-button>
    <el-button @click="exportJson">复制 JSON</el-button>
  </div>

  <el-dialog v-model="importVisible" title="导入表单 Schema" width="680px">
    <el-input
      v-model="importText"
      class="code-modal"
      type="textarea"
      :rows="18"
      placeholder="粘贴由本设计器导出的 JSON"
    />
    <template #footer>
      <el-button @click="importVisible = false">取消</el-button>
      <el-button type="primary" @click="applyImport">校验并导入</el-button>
    </template>
  </el-dialog>
</template>
