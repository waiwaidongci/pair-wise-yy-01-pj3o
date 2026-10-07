import type { FieldNode, FormSchema, TableColumn, ValidationRule, VisibilityCondition } from './form'

/**
 * A field node flattened into a path-addressable record.
 * `parentId` / `index` capture the tree structure so moves are just
 * path changes like `node:<id>.parentId`.
 */
export interface FlatNode {
  id: string
  parentId: string | null
  index: number
  type: FieldNode['type']
  label: string
  name: string
  placeholder?: string
  defaultValue?: unknown
  options?: string[]
  columns?: TableColumn[]
  validation?: ValidationRule
  condition?: VisibilityCondition
}

/** A single path-addressed change committed by a tab. */
export type PathOp =
  | { kind: 'set'; path: string; value: unknown }
  | { kind: 'add'; id: string; node: FlatNode }
  | { kind: 'remove'; id: string }

/**
 * A revision is one tab's batch of changes against a published baseline.
 * `opId` is the idempotency key: replaying the same opId must never create
 * a second revision.
 */
export interface Revision {
  opId: string
  tabId: string
  baseVersion: number
  ops: PathOp[]
  createdAt: string
}

export interface StoredRevision extends Revision {}

/** A same-path change made by both sides, kept pending for resolution. */
export interface PathConflict {
  path: string
  nodeId: string
  prop: string
  label: string
  left: unknown
  right: unknown
}

/** A condition pointing at a field that no longer exists in the schema. */
export interface DanglingRef {
  nodeId: string
  nodeLabel: string
  fieldId: string
}

/** The shared, published state persisted in localStorage. */
export interface SharedState {
  baselineVersion: number
  baseline: FormSchema
  revisions: StoredRevision[]
  savedAt: string
}

export type SyncStatus = 'idle' | 'pending' | 'syncing' | 'synced' | 'error'

export interface CommitResult {
  ok: boolean
  deduped?: boolean
  error?: string
  revision?: StoredRevision
}
