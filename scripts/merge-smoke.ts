// Smoke test for the path-merge engine. Bundled with esbuild and run in Node.
import { createStarterSchema } from '../src/utils/schema'
import {
  applyOpsToSchema,
  diffMeta,
  diffSchemas,
  findDanglingRefs,
  flattenSchema,
  mergeThreeWay,
  unflattenSchema,
} from '../src/utils/pathMerge'
import { loadShared } from '../src/utils/storageServer'
import type { FormSchema } from '../src/types/form'

let failures = 0
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  PASS: ${msg}`)
  } else {
    failures++
    console.error(`  FAIL: ${msg}`)
  }
}

const base = createStarterSchema()
const fieldA = base.nodes[0]
const fieldB = base.nodes[1]

// --- Scenario 1: different paths merge directly -------------------------
{
  console.log('\n[1] Different paths merge directly')
  const left: FormSchema = JSON.parse(JSON.stringify(base))
  left.nodes[0].label = '左侧改的标题'
  const right: FormSchema = JSON.parse(JSON.stringify(base))
  right.nodes[1].name = 'right_changed_name'

  const result = mergeThreeWay(base, left, right)
  const merged = unflattenSchema(result.nodes, { title: result.title, description: result.description }, 1)
  assert(merged.nodes[0].label === '左侧改的标题', 'left change merged')
  assert(merged.nodes[1].name === 'right_changed_name', 'right change merged')
  assert(result.conflicts.length === 0, 'no conflicts for disjoint paths')
}

// --- Scenario 2: same path changed by both -> conflict -------------------
{
  console.log('\n[2] Same path both changed -> conflict pending')
  const left: FormSchema = JSON.parse(JSON.stringify(base))
  left.nodes[0].label = '左边标题'
  const right: FormSchema = JSON.parse(JSON.stringify(base))
  right.nodes[0].label = '右边标题'

  const result = mergeThreeWay(base, left, right)
  assert(result.conflicts.length === 1, 'one conflict recorded')
  assert(result.conflicts[0].left === '左边标题', 'conflict keeps left value')
  assert(result.conflicts[0].right === '右边标题', 'conflict keeps right value')
  assert(result.conflicts[0].path === `node:${fieldA.id}.label`, 'conflict path is node:<id>.label')
  // base value kept in merged pending resolution
  const merged = unflattenSchema(result.nodes, { title: result.title, description: result.description }, 1)
  assert(merged.nodes[0].label === base.nodes[0].label, 'base value kept pending resolution')
}

// --- Scenario 3: same path changed equally -> no conflict ----------------
{
  console.log('\n[3] Same path changed identically -> no conflict')
  const left: FormSchema = JSON.parse(JSON.stringify(base))
  left.nodes[0].label = '相同标题'
  const right: FormSchema = JSON.parse(JSON.stringify(base))
  right.nodes[0].label = '相同标题'

  const result = mergeThreeWay(base, left, right)
  assert(result.conflicts.length === 0, 'identical changes do not conflict')
  const merged = unflattenSchema(result.nodes, { title: result.title, description: result.description }, 1)
  assert(merged.nodes[0].label === '相同标题', 'identical value taken')
}

// --- Scenario 4: dangling condition reference ----------------------------
{
  console.log('\n[4] Dangling condition reference detected')
  const map = flattenSchema(base)
  // Find a node whose condition points to fieldB, then remove fieldB.
  const owner = [...map.values()].find((fn) => fn.condition?.fieldId === fieldB.id)
  assert(!!owner, 'precondition: a node references fieldB')
  map.delete(fieldB.id)
  const dangling = findDanglingRefs(map)
  assert(dangling.length === 2, 'two dangling refs found (amount + table reference fieldB)')
  assert(dangling.some((d) => d.nodeId === owner!.id), 'dangling ref owned by the referencing node')
  assert(dangling.every((d) => d.fieldId === fieldB.id), 'all dangling refs point to removed fieldB')
}

// --- Scenario 5: applyOpsToSchema round-trips a diff ---------------------
{
  console.log('\n[5] diff -> applyOps round-trip')
  const left: FormSchema = JSON.parse(JSON.stringify(base))
  left.nodes[0].label = '新标题'
  left.title = '新表单标题'
  const ops = [
    ...diffMeta(base, left),
    ...diffSchemas(flattenSchema(base), flattenSchema(left)),
  ]
  const applied = applyOpsToSchema(base, ops)
  assert(applied.nodes[0].label === '新标题', 'applied label change')
  assert(applied.title === '新表单标题', 'applied title change')
}

// --- Scenario 6: move is a path change, not a full overwrite -------------
{
  console.log('\n[6] Move is a path change')
  const left: FormSchema = JSON.parse(JSON.stringify(base))
  // move fieldA (index 0) to index 1
  const [moved] = left.nodes.splice(0, 1)
  left.nodes.splice(1, 0, moved)
  const right: FormSchema = JSON.parse(JSON.stringify(base))
  right.nodes[2].label = '右侧改的第三个字段'

  const result = mergeThreeWay(base, left, right)
  const merged = unflattenSchema(result.nodes, { title: result.title, description: result.description }, 1)
  assert(merged.nodes[1].id === fieldA.id, 'move merged (fieldA now at index 1)')
  assert(merged.nodes[2].label === '右侧改的第三个字段', 'right label change merged alongside move')
  assert(result.conflicts.length === 0, 'move + label change do not conflict')
}

// --- Scenario 7: remove + modify conflict ---------------------------------
{
  console.log('\n[7] Remove on one side + modify on other -> conflict')
  const left: FormSchema = JSON.parse(JSON.stringify(base))
  left.nodes[0].label = '左边改了标题'
  const right: FormSchema = JSON.parse(JSON.stringify(base))
  right.nodes.splice(0, 1) // right removed fieldA

  const result = mergeThreeWay(base, left, right)
  assert(result.conflicts.length === 1, 'modify/remove conflict recorded')
}

// --- Scenario 8: rebase local edits onto a newly published baseline -------
{
  console.log('\n[8] Rebase local edits onto new baseline')
  const v1 = base
  const local: FormSchema = JSON.parse(JSON.stringify(v1))
  local.nodes[0].label = '本地改的标题'
  const v2: FormSchema = JSON.parse(JSON.stringify(v1))
  v2.nodes[1].label = '新基线改的标题' // another tab published this

  const result = mergeThreeWay(v1, local, v2, { onConflict: 'keep-left' })
  const rebased = unflattenSchema(result.nodes, { title: result.title, description: result.description }, 1)
  assert(rebased.nodes[0].label === '本地改的标题', 'local edit preserved after rebase')
  assert(rebased.nodes[1].label === '新基线改的标题', 'new baseline change brought in')
}

// --- Scenario 9: legacy draft migration preserves content ----------------
{
  console.log('\n[9] Legacy draft migration preserves content')
  const fakeStore = new Map<string, string>()
  const legacy = {
    version: 1,
    title: '旧稿标题',
    description: '旧稿说明',
    nodes: JSON.parse(JSON.stringify(base.nodes)),
    updatedAt: '2024-01-01T00:00:00.000Z',
  }
  // storageServer reads localStorage; inject a fake one.
  const originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage
  ;(globalThis as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => fakeStore.get(k) ?? null,
    setItem: (k: string, v: string) => void fakeStore.set(k, v),
    removeItem: (k: string) => void fakeStore.delete(k),
    clear: () => fakeStore.clear(),
    key: (i: number) => [...fakeStore.keys()][i] ?? null,
    get length() { return fakeStore.size },
  }
  fakeStore.set('formcraft-schema-v1', JSON.stringify(legacy))
  const migrated = loadShared()
  assert(migrated.baselineVersion === 1, 'migrated baseline starts at v1')
  assert(migrated.baseline.title === '旧稿标题', 'legacy title preserved')
  assert(migrated.baseline.description === '旧稿说明', 'legacy description preserved')
  assert(migrated.baseline.nodes.length === base.nodes.length, 'legacy nodes preserved')
  assert(migrated.revisions.length === 0, 'migrated revision log is empty')
  ;(globalThis as { localStorage?: Storage }).localStorage = originalLocalStorage
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
