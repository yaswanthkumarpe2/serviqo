/**
 * Base class every application error inherits from. errorHandler
 * middleware trusts `httpStatus`/`code`/`message` on any AppError to be
 * safe to send to a client; anything that isn't an AppError is treated as
 * unexpected and collapsed to a generic 500 (see middleware/errorHandler.ts).
 */
export abstract class AppError extends Error {
  abstract readonly httpStatus: number;
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = this.constructor.name;
  }
}
