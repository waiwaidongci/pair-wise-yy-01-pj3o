import type { FieldNode, FormSchema } from '../types/form'
import { cloneSchema, findNode, insertNode, removeNode } from './schema'
import { createId } from './id'

/**
 * 离线修订合并核心：所有改动都按「字段路径」寻址。
 *
 * 路径约定：
 * - meta:title / meta:description  表单级属性
 * - add:<fieldId>                  新增节点（值携带整棵子树）
 * - remove:<fieldId>               移除节点
 * - move:<fieldId>                 移动节点（父级 / 序号变化）
 * - set:<fieldId>:<propKey>        节点属性写入
 */
const TRACKED_PROPS = ['label', 'name', 'placeholder', 'defaultValue', 'options', 'columns', 'validation', 'condition'] as const

export type ChangeKind = 'add' | 'remove' | 'move' | 'set'

export interface MoveTarget {
  parentId: string | null
  index: number
}

export interface AddPayload {
  node: FieldNode
  parentId: string | null
  index: number
}

export interface FieldChange {
  kind: ChangeKind
  path: string
  fieldId?: string
  key?: string
  value?: unknown
  /** 属性被显式清除（JSON 无法携带 undefined，用该标记区分） */
  cleared?: boolean
}

export interface Revision {
  /** 操作号：同一批次重放时保持不变，保证只生成一次修订 */
  opId: string
  tabId: string
  tabLabel: string
  /** 提交时所基于的基线版本 */
  baseVersion: number
  changes: FieldChange[]
  createdAt: string
}

export interface Resolution {
  opId: string
  path: string
  value?: unknown
  cleared?: boolean
  baseVersion: number
  resolvedAt: string
}

export interface DraftDoc {
  baseVersion: number
  revisions: Revision[]
  resolutions: Record<string, Resolution>
}

export interface BaselineDoc {
  version: number
  schema: FormSchema
  publishedAt: string
}

export interface ConflictSide {
  tabId: string
  tabLabel: string
  opId: string
  value?: unknown
  cleared?: boolean
}

export interface ConflictEntry {
  path: string
  kind: ChangeKind
  fieldId?: string
  key?: string
  /** 双方（或多方）各自写入的值，全部保留等待处理 */
  sides: ConflictSide[]
  /** 当前临时生效的一侧（先写入者） */
  applied: ConflictSide
}

export interface DanglingRef {
  ownerId: string
  ownerLabel: string
  missingFieldId: string
}

export interface MergeResult {
  schema: FormSchema
  conflicts: ConflictEntry[]
  dangling: DanglingRef[]
}

interface NodeLoc {
  node: FieldNode
  parentId: string | null
  index: number
}

function indexNodes(nodes: FieldNode[], parentId: string | null, map: Map<string, NodeLoc>): void {
  nodes.forEach((node, index) => {
    map.set(node.id, { node, parentId, index })
    indexNodes(node.children ?? [], node.id, map)
  })
}

function valueKey(value: unknown, cleared?: boolean): string {
  return cleared ? '<cleared>' : JSON.stringify(value ?? null)
}

/** 对比两版 Schema，产出按字段路径寻址的改动列表 */
export function diffSchemas(prev: FormSchema, next: FormSchema): FieldChange[] {
  const changes: FieldChange[] = []
  if (prev.title !== next.title) {
    changes.push({ kind: 'set', path: 'meta:title', key: 'title', value: next.title })
  }
  if (prev.description !== next.description) {
    changes.push({ kind: 'set', path: 'meta:description', key: 'description', value: next.description })
  }

  const prevMap = new Map<string, NodeLoc>()
  const nextMap = new Map<string, NodeLoc>()
  indexNodes(prev.nodes, null, prevMap)
  indexNodes(next.nodes, null, nextMap)

  for (const [id, loc] of nextMap) {
    if (prevMap.has(id)) continue
    const payload: AddPayload = { node: cloneSchema(loc.node), parentId: loc.parentId, index: loc.index }
    changes.push({ kind: 'add', path: `add:${id}`, fieldId: id, value: payload })
  }

  for (const [id, loc] of nextMap) {
    const before = prevMap.get(id)
    if (!before) continue
    if (before.parentId !== loc.parentId || before.index !== loc.index) {
      const target: MoveTarget = { parentId: loc.parentId, index: loc.index }
      changes.push({ kind: 'move', path: `move:${id}`, fieldId: id, value: target })
    }
    for (const key of TRACKED_PROPS) {
      const a = (before.node as unknown as Record<string, unknown>)[key]
      const b = (loc.node as unknown as Record<string, unknown>)[key]
      if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue
      changes.push({
        kind: 'set',
        path: `set:${id}:${key}`,
        fieldId: id,
        key,
        value: b === undefined ? undefined : cloneSchema(b),
        cleared: b === undefined,
      })
    }
  }

  for (const id of prevMap.keys()) {
    if (!nextMap.has(id)) changes.push({ kind: 'remove', path: `remove:${id}`, fieldId: id, value: true })
  }
  return changes
}

/** 把单条改动应用到 Schema 上（应用失败时静默跳过，由合并层兜底） */
export function applyChange(schema: FormSchema, change: FieldChange): void {
  switch (change.kind) {
    case 'add': {
      const payload = change.value as AddPayload
      if (findNode(schema.nodes, payload.node.id)) return // 幂等：重复 add 直接跳过
      const node = cloneSchema(payload.node)
      if (!insertNode(schema.nodes, node, payload.parentId ?? undefined, payload.index)) schema.nodes.push(node)
      return
    }
    case 'remove': {
      if (change.fieldId) removeNode(schema.nodes, change.fieldId)
      return
    }
    case 'move': {
      if (!change.fieldId) return
      const target = change.value as MoveTarget
      const node = findNode(schema.nodes, change.fieldId)
      if (!node) return
      const cloned = cloneSchema(node)
      removeNode(schema.nodes, change.fieldId)
      if (!insertNode(schema.nodes, cloned, target.parentId ?? undefined, target.index)) schema.nodes.push(cloned)
      return
    }
    case 'set': {
      if (change.path === 'meta:title') {
        schema.title = String(change.value ?? '')
        return
      }
      if (change.path === 'meta:description') {
        schema.description = String(change.value ?? '')
        return
      }
      if (!change.fieldId || !change.key) return
      const node = findNode(schema.nodes, change.fieldId)
      if (!node) return // 字段已被移除：写入落空，悬空引用由 findDanglingRefs 兜底
      if (change.cleared) delete (node as unknown as Record<string, unknown>)[change.key]
      else (node as unknown as Record<string, unknown>)[change.key] = cloneSchema(change.value)
    }
  }
}

/**
 * 合并草稿文档：从基线出发按修订顺序重放全部改动。
 * - 不同路径互不影响，直接合入；
 * - 同一路径被多个标签页改成不同值时保留双方值，先写入者临时生效；
 * - 已有决议（Resolution）的路径按决议取值，不再计入冲突。
 */
export function mergeDraft(baseline: FormSchema, doc: DraftDoc): MergeResult {
  interface PathEntry {
    revision: Revision
    change: FieldChange
    seq: number
  }
  const byPath = new Map<string, PathEntry[]>()
  let seq = 0
  for (const revision of doc.revisions) {
    for (const change of revision.changes) {
      const list = byPath.get(change.path) ?? []
      list.push({ revision, change, seq: seq += 1 })
      byPath.set(change.path, list)
    }
  }

  const conflicts: ConflictEntry[] = []
  const winners: Array<{ change: FieldChange; seq: number }> = []

  for (const [path, entries] of byPath) {
    const resolution = doc.resolutions[path]
    const latest = entries[entries.length - 1]
    if (resolution) {
      winners.push({ change: { ...latest.change, value: resolution.value, cleared: resolution.cleared }, seq: latest.seq })
      continue
    }
    // 每个标签页在该路径上的最终取值
    const sideByTab = new Map<string, ConflictSide>()
    for (const { revision, change } of entries) {
      sideByTab.set(revision.tabId, {
        tabId: revision.tabId,
        tabLabel: revision.tabLabel,
        opId: revision.opId,
        value: change.value,
        cleared: change.cleared,
      })
    }
    const distinct = new Set([...sideByTab.values()].map((side) => valueKey(side.value, side.cleared)))
    if (distinct.size <= 1) {
      winners.push({ change: latest.change, seq: latest.seq })
      continue
    }
    const first = entries[0]
    winners.push({ change: first.change, seq: first.seq })
    conflicts.push({
      path,
      kind: first.change.kind,
      fieldId: first.change.fieldId,
      key: first.change.key,
      sides: [...sideByTab.values()],
      applied: {
        tabId: first.revision.tabId,
        tabLabel: first.revision.tabLabel,
        opId: first.revision.opId,
        value: first.change.value,
        cleared: first.change.cleared,
      },
    })
  }

  const schema = cloneSchema(baseline)
  // 按 新增 → 属性写入 → 移动 → 删除 的相位应用，保证同批次内的依赖顺序
  const phase: Record<ChangeKind, number> = { add: 0, set: 1, move: 2, remove: 3 }
  const ordered = [...winners].sort((a, b) => phase[a.change.kind] - phase[b.change.kind] || a.seq - b.seq)
  for (const { change } of ordered) applyChange(schema, change)

  return { schema, conflicts, dangling: findDanglingRefs(schema) }
}

/** 悬空引用：联动条件指向的字段已不在合并结果中 */
export function findDanglingRefs(schema: FormSchema): DanglingRef[] {
  const ids = new Set<string>()
  const collect = (nodes: FieldNode[]) => {
    for (const node of nodes) {
      ids.add(node.id)
      collect(node.children ?? [])
    }
  }
  collect(schema.nodes)

  const dangling: DanglingRef[] = []
  const check = (nodes: FieldNode[]) => {
    for (const node of nodes) {
      const fieldId = node.condition?.fieldId
      if (fieldId && !ids.has(fieldId)) {
        dangling.push({ ownerId: node.id, ownerLabel: node.label, missingFieldId: fieldId })
      }
      check(node.children ?? [])
    }
  }
  check(schema.nodes)
  return dangling
}

export function emptyDraft(baseVersion: number): DraftDoc {
  return { baseVersion, revisions: [], resolutions: {} }
}

export function createRevision(
  tabId: string,
  tabLabel: string,
  baseVersion: number,
  changes: FieldChange[],
  opId: string = createId('op'),
): Revision {
  return { opId, tabId, tabLabel, baseVersion, changes, createdAt: new Date().toISOString() }
}

/** 追加修订；同号（opId）重放只生成一次，返回 added=false */
export function appendRevision(doc: DraftDoc, revision: Revision): { doc: DraftDoc; added: boolean } {
  if (doc.revisions.some((item) => item.opId === revision.opId)) return { doc, added: false }
  return { doc: { ...doc, revisions: [...doc.revisions, revision] }, added: true }
}

/** 写入冲突决议；同号重放不产生变化 */
export function upsertResolution(doc: DraftDoc, resolution: Resolution): { doc: DraftDoc; added: boolean } {
  const existing = doc.resolutions[resolution.path]
  if (existing?.opId === resolution.opId) return { doc, added: false }
  return { doc: { ...doc, resolutions: { ...doc.resolutions, [resolution.path]: resolution } }, added: true }
}

/**
 * 合并两侧草稿文档（持久化前读-改-写用）：
 * 修订按 opId 求并集，基线版本推进前的旧修订与旧决议视为已归档，直接丢弃。
 */
export function mergeStoredDraft(stored: DraftDoc, local: DraftDoc): DraftDoc {
  const baseVersion = Math.max(stored.baseVersion, local.baseVersion)
  const seen = new Set<string>()
  const revisions: Revision[] = []
  for (const revision of [...stored.revisions, ...local.revisions]) {
    if (revision.baseVersion < baseVersion || seen.has(revision.opId)) continue
    seen.add(revision.opId)
    revisions.push(revision)
  }
  const resolutions: Record<string, Resolution> = {}
  for (const resolution of [...Object.values(stored.resolutions), ...Object.values(local.resolutions)]) {
    if (resolution.baseVersion < baseVersion) continue
    const existing = resolutions[resolution.path]
    if (!existing || existing.resolvedAt <= resolution.resolvedAt) resolutions[resolution.path] = resolution
  }
  return { baseVersion, revisions, resolutions }
}

/** 旧版草稿（无版本信息的纯 FormSchema）迁移为基线 v1 + 空草稿，原内容完整保留 */
export function migrateLegacySchema(raw: string, now: string = new Date().toISOString()): { baseline: BaselineDoc; draft: DraftDoc } | null {
  try {
    const parsed = JSON.parse(raw) as Partial<FormSchema>
    if (!parsed || typeof parsed.title !== 'string' || !Array.isArray(parsed.nodes)) return null
    const schema: FormSchema = {
      version: 1,
      title: parsed.title,
      description: typeof parsed.description === 'string' ? parsed.description : '',
      nodes: parsed.nodes as FieldNode[],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now,
    }
    return { baseline: { version: 1, schema, publishedAt: now }, draft: emptyDraft(1) }
  } catch {
    return null
  }
}

export const PROP_LABELS: Record<string, string> = {
  label: '显示标题',
  name: '字段标识',
  placeholder: '占位提示',
  defaultValue: '默认值',
  options: '选择项',
  columns: '表格列',
  validation: '校验规则',
  condition: '联动条件',
  title: '表单标题',
  description: '表单说明',
}

/** 冲突的人类可读描述，依次在合并结果、基线中查找字段名 */
export function describeConflict(conflict: ConflictEntry, ...schemas: FormSchema[]): string {
  if (conflict.path.startsWith('meta:')) return PROP_LABELS[conflict.key ?? ''] ?? conflict.path
  let label = conflict.fieldId ?? ''
  for (const schema of schemas) {
    const node = conflict.fieldId ? findNode(schema.nodes, conflict.fieldId) : undefined
    if (node) {
      label = node.label
      break
    }
  }
  if (conflict.kind === 'move') return `「${label}」的位置`
  return `「${label}」的${PROP_LABELS[conflict.key ?? ''] ?? conflict.key ?? ''}`
}

/** 冲突一侧取值的人类可读摘要 */
export function formatSideValue(side: { value?: unknown; cleared?: boolean }, kind?: ChangeKind): string {
  if (side.cleared) return '（清除该属性）'
  if (kind === 'move') {
    const target = side.value as MoveTarget
    return `移动到${target.parentId ? `分组 ${target.parentId.slice(-4)}` : '根层级'} 第 ${target.index + 1} 位`
  }
  const text = JSON.stringify(side.value ?? null)
  return text.length > 80 ? `${text.slice(0, 77)}…` : text
}
