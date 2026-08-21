// docs/plan/00-conventions.md: "typed AppError with a stable code; never
// leak internals to responses." The repository layer is the first place
// that needs a typed, catchable failure, so it's introduced here.
//
// TASK 2.1.2 (R-09): the message is redacted on construction. An error
// message is one of the four exits docs/plan/09-self-audit.md's red-team
// names — "an export, a log line, an error message, a cache" — and it is
// the one that most often carries a whole record, because the easiest way
// to write a useful failure is to interpolate the thing that failed. By
// the time a message reaches this constructor it is a string, so the
// structural walk in projection.ts cannot help; `redactPrivateText` drops
// everything from a `private:` key onward instead. Callers do not have to
// remember: there is no way to build an AppError that skips it.
import { redactPrivateText } from './projection.js';

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(redactPrivateText(message));
    this.name = 'AppError';
  }
}
