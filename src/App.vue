<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Document, View } from '@element-plus/icons-vue'
import { useDesignerStore } from './stores/designer'

const route = useRoute()
const router = useRouter()
const store = useDesignerStore()
const activeView = computed(() => route.name === 'preview' ? 'preview' : 'designer')

function switchView(view: string) {
  store.commitDraft()
  router.push(view === 'preview' ? '/preview' : '/')
}
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="brand">
        <div class="brand-mark">FC</div>
        <div>
          <strong>FormCraft</strong>
          <span>业务表单工作台</span>
        </div>
      </div>
      <div class="header-actions">
        <span class="save-state">{{ store.saveState }}</span>
        <el-radio-group :model-value="activeView" @change="switchView">
          <el-radio-button value="designer">
            <el-icon><Document /></el-icon>
            设计器
          </el-radio-button>
          <el-radio-button value="preview">
            <el-icon><View /></el-icon>
            实时预览
          </el-radio-button>
        </el-radio-group>
      </div>
    </header>
    <main class="app-main">
      <router-view />
    </main>
  </div>
</template>
