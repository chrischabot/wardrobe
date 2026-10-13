import type { CommandErrorBody, CommandErrorCode } from "@garderobe/contracts";

/** Error thrown by the command service and read helpers. Nothing was written when this is thrown. */
export class CommandError extends Error {
  readonly code: CommandErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: CommandErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.details = details;
  }

  toBody(): CommandErrorBody {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isCommandError(e: unknown): e is CommandError {
  return e instanceof CommandError || (typeof e === "object" && e !== null && (e as { name?: string }).name === "CommandError");
}
