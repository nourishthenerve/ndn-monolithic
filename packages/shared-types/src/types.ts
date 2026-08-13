// docs/plan/04-data-model-rbac.md's record shape, enforced by Repository
// (services/api/src/repository.ts) on every write. 'deleted' is a status
// flag, not a removed row — see 00-conventions.md's prohibition on
// DeleteItem/DeleteObject.
//
// BaseRecord is generic over its own Status union (defaulting to
// RecordStatus) because not every entity's lifecycle is active|deleted —
// TASK 1.3.1's ContentItem (content.ts) is 'draft'|'published'|'unpublished'
// and is never 'deleted' at all (publish/unpublish only ever transitions
// status, per 00-conventions.md). Repository<T extends BaseRecord> keeps
// its existing active|deleted behaviour unchanged (the default type
// parameter), so entities with the ordinary lifecycle are unaffected.
export type RecordStatus = 'active' | 'deleted';

export interface BaseRecord<Status extends string = RecordStatus> {
  readonly created_at: string;
  updated_at: string;
  status: Status;
}
