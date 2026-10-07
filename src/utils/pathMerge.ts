import type { FieldNode, FormSchema } from '../types/form'
import type { DanglingRef, FlatNode, PathConflict, PathOp } from '../types/collab'
import { cloneSchema } from './schema'

// ---------------------------------------------------------------------------
// Path helpers. A node path is `node:<id>.<prop>`; ids never contain dots.
// ---------------------------------------------------------------------------

export function nodePath(id: string, prop: string): string {
  return `node:${id}.${prop}`
}

export function parseNodePath(path: string): { id: string; prop: string } | null {
  if (!path.startsWith('node:')) return null
  const rest = path.slice('node:'.length)
  const dot = rest.indexOf('.')
  if (dot < 0) return null
  return { id: rest.slice(0, dot), prop: rest.slice(dot + 1) }
}

const PROP_LABELS: Record<string, string> = {
  label: '标题',
  name: '字段标识',
  placeholder: '占位提示',
  defaultValue: '默认值',
  options: '选项',
  columns: '表格列',
  validation: '校验规则',
  condition: '联动条件',
  parentId: '所属分组',
  index: '排序位置',
}

export function propLabel(prop: string): string {
  return PROP_LABELS[prop] ?? prop
}

// ---------------------------------------------------------------------------
// Flatten / unflatten. The UI keeps the nested tree; the merge layer works
// on a flat id-keyed map so that moves are ordinary path changes.
// ---------------------------------------------------------------------------

export function flattenSchema(schema: FormSchema): Map<string, FlatNode> {
  const map = new Map<string, FlatNode>()
  const walk = (nodes: FieldNode[], parentId: string | null) => {
    nodes.forEach((node, index) => {
      const { children, ...rest } = node
      map.set(node.id, { ...(rest as FlatNode), parentId, index })
      walk(children ?? [], node.id)
    })
  }
  walk(schema.nodes, null)
  return map
}

export function unflattenSchema(
  map: Map<string, FlatNode>,
  meta: Pick<FormSchema, 'title' | 'description'>,
  version: FormSchema['version'] = 1,
): FormSchema {
  const ids = new Set(map.keys())
  const childrenOf = new Map<string | null, FlatNode[]>()

  map.forEach((fn) => {
    let parentId = fn.parentId
    // Reconcile dangling parents and cycles: reparent to root.
    if (parentId !== null && !ids.has(parentId)) parentId = null
    if (parentId !== null) {
      const seen = new Set<string>()
      let cur: string | null = parentId
      while (cur !== null) {
        if (cur === fn.id || seen.has(cur)) {
          parentId = null
          break
        }
        seen.add(cur)
        cur = map.get(cur)?.parentId ?? null
      }
    }
    const arr = childrenOf.get(parentId) ?? []
    arr.push(fn)
    childrenOf.set(parentId, arr)
  })

  childrenOf.forEach((arr) => arr.sort((a, b) => a.index - b.index))

  const build = (parentId: string | null): FieldNode[] => {
    const kids = childrenOf.get(parentId) ?? []
    return kids.map((fn) => {
      const { parentId: _p, index: _i, ...rest } = fn
      return { ...(rest as FieldNode), children: build(fn.id) }
    })
  }

  return {
    version,
    title: meta.title,
    description: meta.description,
    nodes: build(null),
    updatedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Deep equality (JSON round-trip is sufficient for this schema's values).
// ---------------------------------------------------------------------------

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a && b && typeof a === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch {
      return false
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Diff two flat maps into path ops (base -> next).
// ---------------------------------------------------------------------------

export function diffSchemas(base: Map<string, FlatNode>, next: Map<string, FlatNode>): PathOp[] {
  const ops: PathOp[] = []
  const ids = new Set([...base.keys(), ...next.keys()])
  ids.forEach((id) => {
    const b = base.get(id)
    const n = next.get(id)
    if (b && !n) {
      ops.push({ kind: 'remove', id })
      return
    }
    if (!b && n) {
      ops.push({ kind: 'add', id, node: cloneSchema(n) })
      return
    }
    if (!b || !n) return
    const keys = new Set([...Object.keys(b), ...Object.keys(n)])
    keys.forEach((k) => {
      const bv = (b as unknown as Record<string, unknown>)[k]
      const nv = (n as unknown as Record<string, unknown>)[k]
      if (!deepEqual(bv, nv)) ops.push({ kind: 'set', path: nodePath(id, k), value: cloneSchema(nv) })
    })
  })
  return ops
}

export function diffMeta(base: Pick<FormSchema, 'title' | 'description'>, next: Pick<FormSchema, 'title' | 'description'>): PathOp[] {
  const ops: PathOp[] = []
  if (!deepEqual(base.title, next.title)) ops.push({ kind: 'set', path: 'title', value: next.title })
  if (!deepEqual(base.description, next.description)) ops.push({ kind: 'set', path: 'description', value: next.description })
  return ops
}

// ---------------------------------------------------------------------------
// Apply ops to a schema (used to fold remote revisions onto the baseline).
// ---------------------------------------------------------------------------

export function applyOpsToSchema(schema: FormSchema, ops: PathOp[]): FormSchema {
  const map = flattenSchema(schema)
  let title = schema.title
  let description = schema.description

  for (const op of ops) {
    if (op.kind === 'add') {
      if (!map.has(op.id)) map.set(op.id, cloneSchema(op.node))
    } else if (op.kind === 'remove') {
      map.delete(op.id)
    } else if (op.kind === 'set') {
      if (op.path === 'title') {
        title = op.value as string
        continue
      }
      if (op.path === 'description') {
        description = op.value as string
        continue
      }
      const parsed = parseNodePath(op.path)
      if (!parsed) continue
      const existing = map.get(parsed.id)
      if (!existing) continue
      map.set(parsed.id, { ...existing, [parsed.prop]: op.value })
    }
  }

  return unflattenSchema(map, { title, description }, schema.version)
}

// ---------------------------------------------------------------------------
// Three-way merge: base vs left (this tab) vs right (other tabs).
// Different paths merge directly; a path changed on both sides with
// differing values is returned as a conflict (base value kept pending).
// ---------------------------------------------------------------------------

export interface MergeResult {
  nodes: Map<string, FlatNode>
  title: string
  description: string
  conflicts: PathConflict[]
}

export interface MergeOptions {
  /**
   * What to keep at a same-path conflict. 'base' keeps the baseline value
   * and records both sides for resolution; 'keep-left' keeps the left value
   * (used when rebasing local edits onto a freshly published baseline).
   */
  onConflict?: 'base' | 'keep-left'
}

export function mergeThreeWay(
  base: FormSchema,
  left: FormSchema,
  right: FormSchema,
  options: MergeOptions = {},
): MergeResult {
  const onConflict = options.onConflict ?? 'base'
  const bm = flattenSchema(base)
  const lm = flattenSchema(left)
  const rm = flattenSchema(right)
  const conflicts: PathConflict[] = []
  const out = new Map<string, FlatNode>()

  const nodeLabel = (id: string): string =>
    lm.get(id)?.label ?? rm.get(id)?.label ?? bm.get(id)?.label ?? id

  const mergeNode = (id: string, b: FlatNode, l: FlatNode, r: FlatNode) => {
    const merged: Record<string, unknown> = { ...b }
    const keys = new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])
    keys.forEach((k) => {
      const bv = (b as unknown as Record<string, unknown>)[k]
      const lv = (l as unknown as Record<string, unknown>)[k]
      const rv = (r as unknown as Record<string, unknown>)[k]
      const lc = !deepEqual(bv, lv)
      const rc = !deepEqual(bv, rv)
      if (lc && rc) {
        if (deepEqual(lv, rv)) {
          merged[k] = lv
        } else {
          conflicts.push({
            path: nodePath(id, k),
            nodeId: id,
            prop: k,
            label: `${nodeLabel(id)} · ${propLabel(k)}`,
            left: lv,
            right: rv,
          })
          merged[k] = onConflict === 'keep-left' ? lv : bv
        }
      } else if (lc) {
        merged[k] = lv
      } else if (rc) {
        merged[k] = rv
      } else {
        merged[k] = bv
      }
    })
    out.set(id, merged as unknown as FlatNode)
  }

  const ids = new Set([...bm.keys(), ...lm.keys(), ...rm.keys()])
  ids.forEach((id) => {
    const b = bm.get(id)
    const l = lm.get(id)
    const r = rm.get(id)

    if (b && l && r) {
      mergeNode(id, b, l, r)
    } else if (b && l && !r) {
      // Right removed; left may have modified.
      if (deepEqual(b, l)) {
        /* removal wins */
      } else {
        conflicts.push({
          path: nodePath(id, '__remove__'),
          nodeId: id,
          prop: '__remove__',
          label: `${nodeLabel(id)} · 节点删除`,
          left: l,
          right: null,
        })
        out.set(id, l)
      }
    } else if (b && !l && r) {
      if (deepEqual(b, r)) {
        /* removal wins */
      } else {
        conflicts.push({
          path: nodePath(id, '__remove__'),
          nodeId: id,
          prop: '__remove__',
          label: `${nodeLabel(id)} · 节点删除`,
          left: null,
          right: r,
        })
        out.set(id, r)
      }
    } else if (b && !l && !r) {
      /* both removed */
    } else if (!b && l && r) {
      if (deepEqual(l, r)) out.set(id, l)
      else {
        conflicts.push({
          path: nodePath(id, '__add__'),
          nodeId: id,
          prop: '__add__',
          label: `${nodeLabel(id)} · 节点新增`,
          left: l,
          right: r,
        })
        out.set(id, onConflict === 'keep-left' ? l : l)
      }
    } else if (!b && l) {
      out.set(id, l)
    } else if (!b && r) {
      out.set(id, r)
    }
  })

  let title = base.title
  if (left.title !== base.title && right.title !== base.title) {
    if (left.title === right.title) title = left.title
    else {
      conflicts.push({ path: 'title', nodeId: '', prop: 'title', label: '表单标题', left: left.title, right: right.title })
      title = onConflict === 'keep-left' ? left.title : base.title
    }
  } else if (left.title !== base.title) title = left.title
  else if (right.title !== base.title) title = right.title

  let description = base.description
  if (left.description !== base.description && right.description !== base.description) {
    if (left.description === right.description) description = left.description
    else {
      conflicts.push({ path: 'description', nodeId: '', prop: 'description', label: '表单说明', left: left.description, right: right.description })
      description = onConflict === 'keep-left' ? left.description : base.description
    }
  } else if (left.description !== base.description) description = left.description
  else if (right.description !== base.description) description = right.description

  return { nodes: out, title, description, conflicts }
}

// ---------------------------------------------------------------------------
// Dangling references: a condition pointing at a field id that no longer
// exists in the merged schema.
// ---------------------------------------------------------------------------

export function findDanglingRefs(map: Map<string, FlatNode>): DanglingRef[] {
  const refs: DanglingRef[] = []
  map.forEach((fn) => {
    const fieldId = fn.condition?.fieldId
    if (fieldId && !map.has(fieldId)) {
      refs.push({ nodeId: fn.id, nodeLabel: fn.label, fieldId })
    }
  })
  return refs
}
