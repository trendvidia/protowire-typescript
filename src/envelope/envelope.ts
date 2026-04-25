/**
 * Standard API response envelope for cross-system communication.
 *
 * Separates transport errors from application errors and carries
 * machine-readable codes with positional format arguments for
 * client-side localization.
 *
 * Wire format mirrors the Go `protowire/envelope` package: field tags
 * 1..N on each struct map to a binary protobuf wire format. The binary
 * codec lives in the `pb` module; this file defines the data shapes,
 * builders, and queries.
 */

export class FieldError {
  constructor(
    public field: string,
    public code: string,
    public message: string = "",
    public args: string[] = [],
  ) {}
}

export class AppError {
  public details: FieldError[] = [];
  public metadata: Record<string, string> = {};

  constructor(
    public code: string,
    public message: string = "",
    public args: string[] = [],
  ) {}

  withField(
    field: string,
    code: string,
    message: string = "",
    ...args: string[]
  ): this {
    this.details.push(new FieldError(field, code, message, args));
    return this;
  }

  withMeta(key: string, value: string): this {
    this.metadata[key] = value;
    return this;
  }
}

export class Envelope {
  public status: number;
  public transportError: string;
  public data: Uint8Array;
  public error: AppError | null;

  constructor(opts: {
    status?: number;
    transportError?: string;
    data?: Uint8Array;
    error?: AppError | null;
  } = {}) {
    this.status = opts.status ?? 0;
    this.transportError = opts.transportError ?? "";
    this.data = opts.data ?? new Uint8Array();
    this.error = opts.error ?? null;
  }

  static ok(status: number, data: Uint8Array): Envelope {
    return new Envelope({ status, data });
  }

  static err(
    status: number,
    code: string,
    message: string = "",
    ...args: string[]
  ): Envelope {
    return new Envelope({ status, error: new AppError(code, message, args) });
  }

  static transportErr(message: string): Envelope {
    return new Envelope({ transportError: message });
  }

  isOk(): boolean {
    return this.transportError === "" && this.error === null;
  }

  isTransportError(): boolean {
    return this.transportError !== "";
  }

  isAppError(): boolean {
    return this.error !== null;
  }

  errorCode(): string {
    return this.error?.code ?? "";
  }

  /**
   * Returns field errors indexed by field name, or null when there are none.
   *
   * Mirrors the Go API which returns nil for both "no app error" and
   * "app error has no details" — callers should treat null as empty.
   */
  fieldErrors(): Record<string, FieldError> | null {
    if (this.error === null || this.error.details.length === 0) return null;
    const out: Record<string, FieldError> = {};
    for (const fe of this.error.details) out[fe.field] = fe;
    return out;
  }
}

export function newAppError(
  code: string,
  message: string = "",
  ...args: string[]
): AppError {
  return new AppError(code, message, args);
}
