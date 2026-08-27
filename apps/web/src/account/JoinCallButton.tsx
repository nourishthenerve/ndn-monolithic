// TASK 4.5.1: the first manual trigger anywhere in this call flow — every
// earlier Phase 4 task auto-advanced on its own (auto-join on mount,
// auto-offer, auto-retry). A native `<button>`, keyboard-reachable by
// construction, deliberately with no state of its own: `VideoCall.tsx`
// decides when this is even reachable (only once `DeviceCheck.tsx` has
// handed off a device stream) and what happens once it fires.
import type { ReactNode } from 'react';

export interface JoinCallButtonStrings {
  readonly label: string;
}

export interface JoinCallButtonProps {
  readonly strings: JoinCallButtonStrings;
  readonly onJoin: () => void;
}

export function JoinCallButton({ strings, onJoin }: JoinCallButtonProps): ReactNode {
  return (
    <button type="button" onClick={onJoin}>
      {strings.label}
    </button>
  );
}
