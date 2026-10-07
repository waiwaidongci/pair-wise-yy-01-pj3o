<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Document, View, Warning } from '@element-plus/icons-vue'
import { useDesignerStore } from './stores/designer'
import CollabDialog from './components/CollabDialog.vue'

const route = useRoute()
const router = useRouter()
const store = useDesignerStore()
const activeView = route.name === 'preview' ? 'preview' : 'designer'

const collabVisible = ref(false)
const collabTab = ref<'conflicts' | 'dangling' | 'log'>('conflicts')

function switchView(view: string) {
  void store.commitDraft()
  router.push(view === 'preview' ? '/preview' : '/')
}

function openCollab(tab: 'conflicts' | 'dangling' | 'log') {
  collabTab.value = tab
  collabVisible.value = true
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
        <el-tag size="small" effect="dark" round>基线 v{{ store.baselineVersion }}</el-tag>
        <el-badge :value="store.conflicts.length" :hidden="store.conflicts.length === 0" type="danger">
          <el-button size="small" plain @click="openCollab('conflicts')">冲突</el-button>
        </el-badge>
        <el-badge :value="store.danglingRefs.length" :hidden="store.danglingRefs.length === 0" type="warning">
          <el-button size="small" plain @click="openCollab('dangling')">悬空引用</el-button>
        </el-badge>
        <el-button size="small" plain @click="openCollab('log')">修订日志</el-button>
        <el-tooltip
          :content="store.canPublish ? '将当前草稿发布为新基线' : '存在未处理的冲突或悬空引用，无法发布'"
          placement="bottom"
        >
          <span>
            <el-button
              size="small"
              type="success"
              :disabled="!store.canPublish"
              @click="store.publish"
            >
              <el-icon><Warning /></el-icon>
              发布
            </el-button>
          </span>
        </el-tooltip>
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

    <CollabDialog v-model="collabVisible" :tab="collabTab" />
  </div>
</template>
