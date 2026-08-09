// docs/plan/00-conventions.md: "time is injectable — no test reads the wall
// clock." Every timestamp the repository layer writes goes through a Clock.
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
