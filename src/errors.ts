/** Odoo answered a JSON-RPC call with an error (access denied, validation, missing record…). */
export class OdooRpcError extends Error {
  override readonly name = "OdooRpcError";

  constructor(
    message: string,
    /** Odoo's exception class, e.g. `odoo.exceptions.AccessError`. */
    readonly odooName: string | undefined,
    /** JSON-RPC error code. */
    readonly code: number | undefined,
    /** Odoo's server-side traceback, when it sends one. */
    readonly debug: string | undefined,
  ) {
    super(message);
  }
}

/** Odoo refused the credentials: wrong database, login, password or API key. */
export class OdooAuthenticationError extends Error {
  override readonly name = "OdooAuthenticationError";
}

/** Odoo could not be reached, answered with a non-2xx status, or did not answer in time. */
export class OdooTransportError extends Error {
  override readonly name = "OdooTransportError";

  constructor(
    message: string,
    /** HTTP status, when Odoo answered. */
    readonly status: number | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** No record carries the requested external ID. */
export class OdooExternalIdNotFound extends Error {
  override readonly name = "OdooExternalIdNotFound";

  constructor(readonly externalId: string) {
    super(`No record found for external ID ${externalId}`);
  }
}
