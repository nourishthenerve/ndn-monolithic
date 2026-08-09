// docs/plan/00-conventions.md: "typed AppError with a stable code; never
// leak internals to responses." The repository layer is the first place
// that needs a typed, catchable failure, so it's introduced here.
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
