// 2026-09-03: a ticking clock for the countdowns.
//
// **The shape here is load-bearing, and getting it wrong has already cost
// this codebase a crashed test worker.** `ClinicianCalendar`/
// `NextAppointmentPanel` take a `now: () => Date` prop whose default used
// to be an inline `() => new Date()` — a new function identity on every
// render, sitting in a `useCallback` dependency array, which turned into
// an unbounded fetch loop against the API.
//
// So: the *function* a caller passes stays stable and is only ever read
// inside the effect that seeds this hook. What ticks is a piece of state,
// which is not a dependency of anything that fetches. A countdown
// re-render must never be able to become a re-fetch.
//
// 30 seconds because the countdown's finest unit is a minute — a tick per
// second would re-render sixty times to change nothing fifty-nine of them,
// and a minute exactly would show a stale value for up to a minute.
import { useEffect, useState } from 'react';

export const CLOCK_TICK_MS = 30_000;

export function useNow(now: () => Date, tickMs: number = CLOCK_TICK_MS): Date {
  const [current, setCurrent] = useState<Date>(() => now());

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrent(now());
    }, tickMs);
    return () => {
      clearInterval(timer);
    };
    // `now` is a stable module-level function in every production caller
    // (`systemNow`), and a fixed clock in tests. It is in the array
    // because it is read, not because it is expected to change.
  }, [now, tickMs]);

  return current;
}
