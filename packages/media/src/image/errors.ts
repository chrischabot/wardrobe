export class ImageDecodeError extends Error {
  readonly reason: "unrecognized" | "unsupported_format" | "too_large" | "corrupt";

  constructor(reason: ImageDecodeError["reason"], message: string) {
    super(message);
    this.name = "ImageDecodeError";
    this.reason = reason;
  }
}

export const DEFAULT_MAX_PIXELS = 40_000_000;
