export abstract class SriDomainError extends Error {
  protected constructor(
    message: string,
    public readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class SriTemporaryError extends SriDomainError {
  constructor(
    message: string,
    code = 'SRI_TEMPORARY_ERROR',
    options?: ErrorOptions,
  ) {
    super(message, code, options);
  }
}

export class SriDefinitiveRejectionError extends SriDomainError {
  constructor(
    message: string,
    code = 'SRI_DEFINITIVE_REJECTION',
    options?: ErrorOptions,
  ) {
    super(message, code, options);
  }
}

export class SignatureConfigurationError extends SriDomainError {
  constructor(
    message: string,
    code = 'SIGNATURE_CONFIGURATION_ERROR',
    options?: ErrorOptions,
  ) {
    super(message, code, options);
  }
}
