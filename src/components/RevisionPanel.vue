<script setup lang="ts">
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { useDesignerStore } from '../stores/designer'
import { useRevisionStore } from '../stores/revision'
import { describeConflict, formatSideValue, type ConflictEntry, type ConflictSide } from '../utils/revision'

const emit = defineEmits<{ close: [] }>()
const store = useDesignerStore()
const revisionStore = useRevisionStore()

const conflicts = computed(() => revisionStore.conflicts)
const dangling = computed(() => revisionStore.dangling)

function describe(conflict: ConflictEntry): string {
  return describeConflict(conflict, revisionStore.mergedSchema, revisionStore.baseline.schema)
}

function sideText(conflict: ConflictEntry, side: ConflictSide): string {
  return formatSideValue(side, conflict.kind)
}

function adoptSide(conflict: ConflictEntry, side: ConflictSide) {
  revisionStore.resolveConflict(conflict.path, side)
  ElMessage.success('已采用所选值，冲突已解决')
}

function locateField(ownerId: string) {
  store.selectNodeById(ownerId)
  emit('close')
}

function clearCondition(ownerId: string) {
  store.clearConditionOf(ownerId)
  ElMessage.success('已清除悬空联动条件')
}

function retry() {
  if (revisionStore.retryPersist()) ElMessage.success('失败批次已重新写入')
}

function publish() {
  if (revisionStore.publish()) {
    ElMessage.success(`已发布为基线 v${revisionStore.baseline.version}，草稿已开启新一轮修订`)
  }
}
</script>

<template>
  <div class="revision-panel">
    <el-alert
      v-if="revisionStore.persistError"
      type="error"
      :closable="false"
      show-icon
      class="panel-block"
    >
      <template #title>草稿写入失败：{{ revisionStore.persistError }}</template>
      失败批次仍保留在本侧，可直接重试（同号修订不会重复生成）。
      <el-button size="small" type="danger" plain style="margin-top: 8px" @click="retry">
        重试写入
      </el-button>
    </el-alert>

    <el-descriptions :column="1" border size="small" class="panel-block">
      <el-descriptions-item label="发布基线">v{{ revisionStore.baseline.version }}</el-descriptions-item>
      <el-descriptions-item label="草稿修订">{{ revisionStore.revisionCount }} 条</el-descriptions-item>
      <el-descriptions-item label="本侧标签页">{{ revisionStore.tabLabel }}</el-descriptions-item>
      <el-descriptions-item label="最近写入">{{ revisionStore.lastPersistedAt ?? '尚未写入' }}</el-descriptions-item>
    </el-descriptions>

    <section class="panel-block">
      <div class="section-head">
        <span class="section-title">同路径冲突</span>
        <el-tag size="small" :type="conflicts.length ? 'danger' : 'success'" effect="light">
          {{ conflicts.length ? `${conflicts.length} 处待处理` : '无冲突' }}
        </el-tag>
      </div>
      <div v-if="conflicts.length" class="conflict-list">
        <div v-for="conflict in conflicts" :key="conflict.path" class="conflict-card">
          <div class="conflict-path">{{ describe(conflict) }}</div>
          <div
            v-for="side in conflict.sides"
            :key="side.opId + side.tabId"
            class="conflict-side"
            :class="{ applied: side.opId === conflict.applied.opId }"
          >
            <div class="side-value">{{ sideText(conflict, side) }}</div>
            <div class="side-meta">
              <span>{{ side.tabLabel }}<template v-if="side.tabId === revisionStore.tabId">（本侧）</template></span>
              <span v-if="side.opId === conflict.applied.opId" class="applied-tag">当前生效</span>
              <el-button size="small" text type="primary" @click="adoptSide(conflict, side)">
                采用该值
              </el-button>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="muted">不同字段路径的改动会自动合入；同一路径两边都改过才会列在这里。</div>
    </section>

    <section class="panel-block">
      <div class="section-head">
        <span class="section-title">悬空联动条件</span>
        <el-tag size="small" :type="dangling.length ? 'warning' : 'success'" effect="light">
          {{ dangling.length ? `${dangling.length} 处待修复` : '无悬空引用' }}
        </el-tag>
      </div>
      <div v-if="dangling.length" class="dangling-list">
        <div v-for="item in dangling" :key="item.ownerId + item.missingFieldId" class="dangling-row">
          <div class="dangling-text">
            「{{ item.ownerLabel }}」的联动条件指向已不存在的字段
            <code>{{ item.missingFieldId }}</code>
          </div>
          <div class="toolbar-row">
            <el-button size="small" text type="primary" @click="locateField(item.ownerId)">定位字段</el-button>
            <el-button size="small" text type="danger" @click="clearCondition(item.ownerId)">清除该条件</el-button>
          </div>
        </div>
      </div>
      <div v-else class="muted">分组被移动或移除后，指向其中字段的条件会列在这里等待修复。</div>
    </section>

    <section class="panel-block">
      <div class="section-head">
        <span class="section-title">发布</span>
      </div>
      <template v-if="revisionStore.canPublish">
        <div class="muted" style="margin-bottom: 10px">合并结果将固化为新基线，草稿修订归档后重新计数。</div>
        <el-button type="success" @click="publish">发布为基线 v{{ revisionStore.baseline.version + 1 }}</el-button>
      </template>
      <template v-else>
        <el-alert type="warning" :closable="false" show-icon title="发布已被挡住，请先处理：">
          <ul class="blocker-list">
            <li v-for="blocker in revisionStore.publishBlockers" :key="blocker">{{ blocker }}</li>
          </ul>
        </el-alert>
        <el-button type="success" disabled style="margin-top: 10px">发布为基线 v{{ revisionStore.baseline.version + 1 }}</el-button>
      </template>
    </section>
  </div>
</template>

<style scoped>
.revision-panel { display: flex; flex-direction: column; gap: 16px; }
.panel-block { display: block; }
.section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.section-title { font-weight: 700; font-size: 13px; color: #26364d; }
.conflict-list { display: grid; gap: 10px; }
.conflict-card { padding: 10px; border: 1px solid #f3c2c2; border-radius: 7px; background: #fff8f8; }
.conflict-path { margin-bottom: 8px; font-size: 13px; font-weight: 650; color: #8c2f39; }
.conflict-side { padding: 8px; border: 1px solid #e5eaf0; border-radius: 6px; background: #fff; }
.conflict-side + .conflict-side { margin-top: 6px; }
.conflict-side.applied { border-color: #f0a6a6; }
.side-value { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #334155; word-break: break-all; }
.side-meta { display: flex; align-items: center; gap: 10px; margin-top: 6px; font-size: 12px; color: #7b8798; }
.applied-tag { color: #d4380d; }
.dangling-list { display: grid; gap: 8px; }
.dangling-row { padding: 9px 10px; border: 1px solid #f5d9a8; border-radius: 7px; background: #fffaf0; }
.dangling-text { margin-bottom: 6px; font-size: 12px; color: #6b4e16; }
.dangling-text code { padding: 1px 4px; border-radius: 4px; background: #f5e8cf; font-size: 11px; }
.blocker-list { margin: 6px 0 0; padding-left: 18px; }
</style>
