<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useDesignerStore } from '../stores/designer'
import { propLabel } from '../utils/pathMerge'
import type { PathConflict } from '../types/collab'

const props = defineProps<{
  modelValue: boolean
  tab?: 'conflicts' | 'dangling' | 'log'
}>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const store = useDesignerStore()
const activeTab = ref(props.tab ?? 'conflicts')

watch(() => props.tab, (v) => { if (v) activeTab.value = v })
watch(() => props.modelValue, (v) => { if (v) activeTab.value = props.tab ?? 'conflicts' })

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

function close() {
  visible.value = false
}

function fmt(value: unknown): string {
  if (value === null || value === undefined) return '（空）'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function resolve(c: PathConflict, side: 'left' | 'right') {
  store.resolveConflict(c.path, side === 'left' ? c.left : c.right)
  ElMessage.success(`已采用${side === 'left' ? '左侧' : '右侧'}值：${c.label}`)
}

function locate(nodeId: string) {
  store.locateNode(nodeId)
  ElMessage.info('已在画布中定位该节点')
}

function clearCondition(nodeId: string) {
  store.clearNodeCondition(nodeId)
  ElMessage.success('已清除悬空联动条件')
}

async function retry() {
  await store.retryCommit()
}

async function replay() {
  const result = await store.replaySameOpId()
  ElMessage.success(result.deduped ? '同操作号重放：未重复生成修订（幂等生效）' : '已用同操作号重放并生成修订')
}

const pendingOpsCount = computed(() => store.pendingBatch?.ops.length ?? 0)
</script>

<template>
  <el-dialog v-model="visible" title="协作与发布" width="760px" top="6vh">
    <el-tabs v-model="activeTab">
      <el-tab-pane name="conflicts">
        <template #label>
          <span>
            待处理冲突
            <el-badge v-if="store.conflicts.length" :value="store.conflicts.length" class="tab-badge" type="danger" />
          </span>
        </template>

        <el-alert
          v-if="!store.conflicts.length"
          type="success"
          :closable="false"
          title="没有冲突"
          description="两侧改动的字段路径互不相同，已直接合入。"
          style="margin-bottom: 12px"
        />

        <div v-for="c in store.conflicts" :key="c.path" class="conflict-card">
          <div class="conflict-head">
            <strong>{{ c.label }}</strong>
            <span class="muted">{{ c.path }}</span>
          </div>
          <div class="conflict-sides">
            <div class="conflict-side">
              <div class="side-tag left">本侧值</div>
              <pre class="side-value">{{ fmt(c.left) }}</pre>
              <el-button size="small" @click="resolve(c, 'left')">保留本侧</el-button>
            </div>
            <div class="conflict-side">
              <div class="side-tag right">另一侧值</div>
              <pre class="side-value">{{ fmt(c.right) }}</pre>
              <el-button size="small" @click="resolve(c, 'right')">采用另一侧</el-button>
            </div>
          </div>
        </div>
      </el-tab-pane>

      <el-tab-pane name="dangling">
        <template #label>
          <span>
            悬空引用
            <el-badge v-if="store.danglingRefs.length" :value="store.danglingRefs.length" class="tab-badge" type="warning" />
          </span>
        </template>

        <el-alert
          v-if="!store.danglingRefs.length"
          type="success"
          :closable="false"
          title="没有悬空引用"
          description="所有联动条件指向的字段都存在。"
          style="margin-bottom: 12px"
        />

        <div v-for="d in store.danglingRefs" :key="d.nodeId" class="dangling-card">
          <div class="conflict-head">
            <strong>{{ d.nodeLabel }}</strong>
            <span class="muted">条件指向已不存在的字段 <code>{{ d.fieldId }}</code></span>
          </div>
          <div class="toolbar-row">
            <el-button size="small" @click="locate(d.nodeId)">定位节点</el-button>
            <el-button size="small" type="danger" plain @click="clearCondition(d.nodeId)">清除条件</el-button>
          </div>
        </div>
      </el-tab-pane>

      <el-tab-pane name="log">
        <template #label>修订日志</template>

        <div class="log-status">
          <el-tag :type="store.syncStatus === 'error' ? 'danger' : store.syncStatus === 'syncing' ? 'warning' : 'success'" effect="plain">
            {{ store.saveState }}
          </el-tag>
          <span class="muted">基线 v{{ store.baselineVersion }} · 本标签页 {{ store.tabId.slice(0, 10) }}</span>
        </div>

        <el-alert
          v-if="store.pendingBatch"
          type="warning"
          :closable="false"
          style="margin: 10px 0"
          :title="`有 ${pendingOpsCount} 项改动的批次尚未写入（操作号 ${store.pendingBatch.opId}）`"
          description="写入失败后原批次已保留，可继续重试；同操作号重放不会重复生成修订。"
        >
          <div class="toolbar-row" style="margin-top: 8px">
            <el-button size="small" type="primary" @click="retry">重试写入</el-button>
            <el-button size="small" @click="replay">用同操作号重放</el-button>
          </div>
        </el-alert>

        <el-table :data="store.revisions" size="small" max-height="360" style="margin-top: 8px">
          <el-table-column prop="opId" label="操作号" width="180">
            <template #default="{ row }"><code>{{ row.opId }}</code></template>
          </el-table-column>
          <el-table-column prop="tabId" label="来源标签页" width="160">
            <template #default="{ row }">{{ row.tabId.slice(0, 16) }}</template>
          </el-table-column>
          <el-table-column prop="baseVersion" label="基线" width="70" />
          <el-table-column label="改动" width="70">
            <template #default="{ row }">{{ row.ops.length }} 项</template>
          </el-table-column>
          <el-table-column prop="createdAt" label="时间">
            <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString('zh-CN') }}</template>
          </el-table-column>
          <template #empty>暂无修订记录</template>
        </el-table>

        <div class="muted" style="margin-top: 10px">
          提示：在另一个标签页打开本应用并编辑字段，修订会按字段路径合入；同一路径被两边修改时进入“待处理冲突”。
        </div>
      </el-tab-pane>
    </el-tabs>

    <template #footer>
      <el-button @click="close">关闭</el-button>
      <el-button
        type="primary"
        :disabled="!store.canPublish"
        @click="store.publish(); close()"
      >
        发布为基线 v{{ store.baselineVersion + 1 }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.tab-badge { margin-left: 6px; }
.conflict-card, .dangling-card {
  padding: 12px;
  margin-bottom: 10px;
  border: 1px solid #e5eaf0;
  border-radius: 8px;
  background: #fafbfd;
}
.conflict-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.conflict-sides { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.conflict-side { padding: 10px; border: 1px solid #e5eaf0; border-radius: 6px; background: #fff; }
.side-tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; color: #fff; margin-bottom: 6px; }
.side-tag.left { background: #2563eb; }
.side-tag.right { background: #059669; }
.side-value { margin: 0 0 8px; padding: 6px; max-height: 120px; overflow: auto; background: #f6f8fb; border-radius: 4px; font-size: 11px; white-space: pre-wrap; word-break: break-all; }
.log-status { display: flex; align-items: center; gap: 12px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #475569; }
</style>
