import { describe, expect, it } from 'vitest'
import { cloneSchema, createField, createStarterSchema, findNode } from './schema'
import {
  appendRevision,
  createRevision,
  diffSchemas,
  emptyDraft,
  findDanglingRefs,
  mergeDraft,
  mergeStoredDraft,
  migrateLegacySchema,
  upsertResolution,
  type DraftDoc,
  type FieldChange,
  type Resolution,
  type Revision,
} from './revision'

function revOf(tabId: string, changes: FieldChange[], opId?: string, baseVersion = 1): Revision {
  return createRevision(tabId, `标签页·${tabId.toUpperCase()}`, baseVersion, changes, opId)
}

function docWith(...revisions: Revision[]): DraftDoc {
  return revisions.reduce((acc, rev) => appendRevision(acc, rev).doc, emptyDraft(1))
}

function setLabel(fieldId: string, value: string): FieldChange {
  return { kind: 'set', path: `set:${fieldId}:label`, fieldId, key: 'label', value }
}

describe('diffSchemas', () => {
  it('识别属性写入、新增、移动、删除与清除', () => {
    const base = createStarterSchema()
    const next = cloneSchema(base)

    const first = next.nodes[0]
    first.label = '改过的标题'

    const amount = next.nodes.find((node) => node.name === 'amount')!
    delete amount.condition // 清除联动条件

    const removed = next.nodes.pop()! // 删除末尾表格

    const swapped = next.nodes[1]
    next.nodes[1] = next.nodes[0]
    next.nodes[0] = swapped // 交换前两个节点 → 移动

    const added = createField('input')
    next.nodes.push(added)

    const changes = diffSchemas(base, next)
    const paths = changes.map((change) => change.path)

    expect(paths).toContain(`set:${first.id}:label`)
    expect(paths).toContain(`add:${added.id}`)
    expect(paths).toContain(`remove:${removed.id}`)
    expect(paths).toContain(`move:${swapped.id}`)

    const cleared = changes.find((change) => change.path === `set:${amount.id}:condition`)
    expect(cleared?.cleared).toBe(true)

    const labelChange = changes.find((change) => change.path === `set:${first.id}:label`)
    expect(labelChange?.value).toBe('改过的标题')
  })

  it('识别表单标题与说明的改动', () => {
    const base = createStarterSchema()
    const next = cloneSchema(base)
    next.title = '新表单名'
    const changes = diffSchemas(base, next)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ kind: 'set', path: 'meta:title', value: '新表单名' })
  })
})

describe('mergeDraft', () => {
  it('不同路径的改动直接合入，不产生冲突', () => {
    const base = createStarterSchema()
    const nodeA = base.nodes[0]
    const nodeB = base.nodes[1]
    const doc = docWith(
      revOf('tabA', [setLabel(nodeA.id, '甲')]),
      revOf('tabB', [setLabel(nodeB.id, '乙')]),
    )
    const result = mergeDraft(base, doc)
    expect(result.conflicts).toHaveLength(0)
    expect(findNode(result.schema.nodes, nodeA.id)?.label).toBe('甲')
    expect(findNode(result.schema.nodes, nodeB.id)?.label).toBe('乙')
  })

  it('同一路径两边都改过：保留双方值，先写入者临时生效', () => {
    const base = createStarterSchema()
    const target = base.nodes[0]
    const doc = docWith(
      revOf('tabA', [setLabel(target.id, '甲')], 'op_a'),
      revOf('tabB', [setLabel(target.id, '乙')], 'op_b'),
    )
    const result = mergeDraft(base, doc)
    expect(result.conflicts).toHaveLength(1)
    const conflict = result.conflicts[0]
    expect(conflict.path).toBe(`set:${target.id}:label`)
    expect(conflict.sides).toHaveLength(2)
    expect(conflict.sides.map((side) => side.value)).toEqual(['甲', '乙'])
    expect(conflict.applied.value).toBe('甲')
    expect(findNode(result.schema.nodes, target.id)?.label).toBe('甲')
  })

  it('同一标签页重复改同一路径不算冲突，取最新值', () => {
    const base = createStarterSchema()
    const target = base.nodes[0]
    const doc = docWith(
      revOf('tabA', [setLabel(target.id, '甲')]),
      revOf('tabA', [setLabel(target.id, '丙')]),
    )
    const result = mergeDraft(base, doc)
    expect(result.conflicts).toHaveLength(0)
    expect(findNode(result.schema.nodes, target.id)?.label).toBe('丙')
  })

  it('两边写入相同的值不算冲突', () => {
    const base = createStarterSchema()
    const target = base.nodes[0]
    const doc = docWith(
      revOf('tabA', [setLabel(target.id, '相同')]),
      revOf('tabB', [setLabel(target.id, '相同')]),
    )
    const result = mergeDraft(base, doc)
    expect(result.conflicts).toHaveLength(0)
    expect(findNode(result.schema.nodes, target.id)?.label).toBe('相同')
  })

  it('决议采用某一侧的值后冲突消除', () => {
    const base = createStarterSchema()
    const target = base.nodes[0]
    const path = `set:${target.id}:label`
    const doc = docWith(
      revOf('tabA', [setLabel(target.id, '甲')], 'op_a'),
      revOf('tabB', [setLabel(target.id, '乙')], 'op_b'),
    )
    const resolution: Resolution = {
      opId: 'op_resolve',
      path,
      value: '乙',
      baseVersion: 1,
      resolvedAt: new Date().toISOString(),
    }
    const { doc: resolved, added } = upsertResolution(doc, resolution)
    expect(added).toBe(true)
    const result = mergeDraft(base, resolved)
    expect(result.conflicts).toHaveLength(0)
    expect(findNode(result.schema.nodes, target.id)?.label).toBe('乙')

    // 同号决议重放不产生变化
    expect(upsertResolution(resolved, resolution).added).toBe(false)
  })

  it('移动冲突同样保留双方目标位置', () => {
    const base = createStarterSchema()
    const target = base.nodes[0]
    const doc = docWith(
      revOf('tabA', [{ kind: 'move', path: `move:${target.id}`, fieldId: target.id, value: { parentId: null, index: 3 } }], 'op_a'),
      revOf('tabB', [{ kind: 'move', path: `move:${target.id}`, fieldId: target.id, value: { parentId: null, index: 1 } }], 'op_b'),
    )
    const result = mergeDraft(base, doc)
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0].kind).toBe('move')
    expect(result.schema.nodes[3]?.id).toBe(target.id)
  })

  it('一侧删除一侧改属性：删除生效，被删字段上的条件列为悬空', () => {
    const base = createStarterSchema()
    const typeNode = base.nodes.find((node) => node.name === 'requestType')!
    const doc = docWith(
      revOf('tabA', [{ kind: 'remove', path: `remove:${typeNode.id}`, fieldId: typeNode.id, value: true }]),
      revOf('tabB', [setLabel(typeNode.id, '改名也没用')]),
    )
    const result = mergeDraft(base, doc)
    expect(result.conflicts).toHaveLength(0) // 路径不同，不算冲突
    expect(findNode(result.schema.nodes, typeNode.id)).toBeUndefined()
    // 申请金额、费用明细的条件都指向被删字段
    expect(result.dangling).toHaveLength(2)
    expect(result.dangling.every((item) => item.missingFieldId === typeNode.id)).toBe(true)
  })

  it('清除标记在合并后移除属性', () => {
    const base = createStarterSchema()
    const amount = base.nodes.find((node) => node.name === 'amount')!
    const doc = docWith(
      revOf('tabA', [{ kind: 'set', path: `set:${amount.id}:condition`, fieldId: amount.id, key: 'condition', cleared: true }]),
    )
    const result = mergeDraft(base, doc)
    expect(findNode(result.schema.nodes, amount.id)?.condition).toBeUndefined()
  })

  it('新增字段携带子树，后续修订可继续改其属性', () => {
    const base = createStarterSchema()
    const added = createField('container')
    const child = createField('input')
    added.children = [child]
    const doc = docWith(
      revOf('tabA', [{ kind: 'add', path: `add:${added.id}`, fieldId: added.id, value: { node: added, parentId: null, index: 0 } }]),
      revOf('tabB', [setLabel(child.id, '容器里的输入框')]),
    )
    const result = mergeDraft(base, doc)
    const mergedContainer = findNode(result.schema.nodes, added.id)
    expect(mergedContainer).toBeDefined()
    expect(findNode(result.schema.nodes, child.id)?.label).toBe('容器里的输入框')
  })
})

describe('appendRevision', () => {
  it('同号重放只生成一次修订', () => {
    const rev = revOf('tabA', [setLabel('field_1', '值')], 'op_same')
    const first = appendRevision(emptyDraft(1), rev)
    expect(first.added).toBe(true)
    const second = appendRevision(first.doc, rev)
    expect(second.added).toBe(false)
    expect(second.doc.revisions).toHaveLength(1)
  })
})

describe('mergeStoredDraft', () => {
  it('按操作号求并集，重复修订只保留一份', () => {
    const r1 = revOf('tabA', [setLabel('f1', 'a')], 'op_1')
    const r2 = revOf('tabB', [setLabel('f2', 'b')], 'op_2')
    const stored: DraftDoc = { baseVersion: 1, revisions: [r1], resolutions: {} }
    const local: DraftDoc = { baseVersion: 1, revisions: [r1, r2], resolutions: {} }
    const merged = mergeStoredDraft(stored, local)
    expect(merged.revisions.map((rev) => rev.opId)).toEqual(['op_1', 'op_2'])
  })

  it('基线版本推进后，旧版本修订与决议归档丢弃', () => {
    const stale = revOf('tabA', [setLabel('f1', 'a')], 'op_old', 1)
    const published: DraftDoc = {
      baseVersion: 2,
      revisions: [],
      resolutions: {},
    }
    const local: DraftDoc = {
      baseVersion: 1,
      revisions: [stale],
      resolutions: {
        'set:f1:label': { opId: 'op_res', path: 'set:f1:label', value: 'x', baseVersion: 1, resolvedAt: '2026-01-01' },
      },
    }
    const merged = mergeStoredDraft(published, local)
    expect(merged.baseVersion).toBe(2)
    expect(merged.revisions).toHaveLength(0)
    expect(Object.keys(merged.resolutions)).toHaveLength(0)
  })
})

describe('findDanglingRefs', () => {
  it('分组移除后，指向其中字段的条件列为悬空', () => {
    const schema = createStarterSchema()
    const container = schema.nodes.find((node) => node.type === 'container')!
    const innerField = container.children![0]
    // 让某个字段的条件指向容器内字段
    schema.nodes[0].condition = { fieldId: innerField.id, operator: 'equals', value: 'x' }
    schema.nodes = schema.nodes.filter((node) => node.id !== container.id)
    const dangling = findDanglingRefs(schema)
    expect(dangling).toHaveLength(1)
    expect(dangling[0]).toMatchObject({ ownerId: schema.nodes[0].id, missingFieldId: innerField.id })
  })
})

describe('migrateLegacySchema', () => {
  it('旧稿迁移为基线 v1，原内容完整保留', () => {
    const legacy = createStarterSchema()
    legacy.title = '旧版草稿标题'
    const migrated = migrateLegacySchema(JSON.stringify(legacy))
    expect(migrated).not.toBeNull()
    expect(migrated!.baseline.version).toBe(1)
    expect(migrated!.baseline.schema.title).toBe('旧版草稿标题')
    expect(migrated!.baseline.schema.nodes).toHaveLength(legacy.nodes.length)
    expect(migrated!.baseline.schema.nodes.map((node) => node.id)).toEqual(legacy.nodes.map((node) => node.id))
    expect(migrated!.draft.baseVersion).toBe(1)
    expect(migrated!.draft.revisions).toHaveLength(0)
  })

  it('非法内容返回 null，不产生任何迁移结果', () => {
    expect(migrateLegacySchema('not json')).toBeNull()
    expect(migrateLegacySchema('{"foo":1}')).toBeNull()
    expect(migrateLegacySchema('{"title":"缺少节点"}')).toBeNull()
  })
})
