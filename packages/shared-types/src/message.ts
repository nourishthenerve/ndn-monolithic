// TASK 3.6.1: `04-data-model-rbac.md`'s key shape for this entity —
// `PAT#<id>` / `MSG#<ts>`, append-only. A message is never edited or
// removed once sent, the one entity in this table a messaging feature
// specifically must not compromise on for a clinical record.
import type { BaseRecord } from './types.js';

export type MessageSenderRole = 'patient' | 'sub-clinician' | 'principal-clinician';

export interface Message extends BaseRecord {
  patientId: string;
  senderId: string;
  senderRole: MessageSenderRole;
  body: string;
}
