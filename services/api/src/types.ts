// docs/plan/04-data-model-rbac.md's record shape, enforced by Repository
// (repository.ts) on every write. 'deleted' is a status flag, not a
// removed row — see 00-conventions.md's prohibition on DeleteItem/DeleteObject.
export type RecordStatus = 'active' | 'deleted';

export interface BaseRecord {
  readonly created_at: string;
  updated_at: string;
  status: RecordStatus;
}
