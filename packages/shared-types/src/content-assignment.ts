// TASK 3.5.1: `04-data-model-rbac.md`'s key shape for this entity is
// deliberately minimal — `PAT#<id>` / `CONTENT#<id>`, no payload beyond
// the link itself. The content item's own title/body/translations
// already live in full at `CONTENT#<id>` / `META` (TASK 1.3.1); this
// type is the assignment relationship alone.
import type { BaseRecord } from './types.js';

export interface ContentAssignment extends BaseRecord {
  patientId: string;
  contentId: string;
  /** ISO-8601, UTC — the same value as `created_at`, kept as its own named field because "when was this assigned" is a fact the read side names directly, not something a caller should have to know is `created_at` under another name. */
  assignedAt: string;
}
