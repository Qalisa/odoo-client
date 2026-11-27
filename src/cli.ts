import type {
  ConnectionWithApiKeyCredentials,
  ConnectionWithPasswordCredentials,
  FObject,
  OdooAuthenticateResponse,
  OdooAuthenticateWithApiKeyResponse,
  OdooAuthenticateWithCredentialsResponse,
  OdooConnection,
  OdooSearchDomain,
  OdooSearchReadOptions,
  PrimitiveOrObject,
} from "./types.js";
import {
  OdooAuthenticationError,
  OdooExternalIdNotFound,
  OdooRpcError,
  OdooTransportError,
} from "./errors.js";
import { Try, isCredentialsResponse } from "./utils.js";

export type OdooClientOptions = {
  /** Replaces the global fetch, e.g. in tests. */
  fetch?: typeof fetch;
  /** Gives up on a call after this many milliseconds. Defaults to 30 000. */
  timeoutMs?: number;
};

type JsonRpcResponse<T> = {
  result?: T;
  error?: {
    code?: number;
    message?: string;
    data?: { name?: string; message?: string; debug?: string };
  };
};

export default class OdooJSONRpc {
  public is_connected = false;
  public url: string | undefined;

  //
  private _auth_response: OdooAuthenticateResponse | undefined;
  private _uid: number | undefined;

  //
  private _config: OdooConnection;
  private _session_id: string | undefined;
  private _api_key: string | undefined;
  private _fetch: typeof fetch;
  private _timeoutMs: number;

  //Initializes the OdooJSONRpc instance with the provided configuration.
  private _initialize() {
    if (!this._config.baseUrl || !this._config.db) {
      throw new TypeError(
        "Incomplete configuration. Please at least provide baseUrl and db",
      );
    }

    //
    const url = new URL(this._config.baseUrl);
    url.port = this._config.port?.toString() ?? "";
    this.url = url.toString();

    // try to determine default port if none provided
    this._config.port ??= (() => {
      if (this._config.baseUrl.startsWith("https")) return 443;
      return 80;
    })();

    //
    if ("sessionId" in this._config) {
      this._session_id = this._config.sessionId;
    } else if ("apiKey" in this._config) {
      this._api_key = this._config.apiKey;
    }
  }

  //
  //
  //

  //Sends one JSON-RPC request and returns its result, or throws a typed error.
  private async _post<T>(
    path: string,
    params: FObject,
    headers: Record<string, string> = {},
  ): Promise<{ result: T; response: Response }> {
    const [response, request_error] = await Try(() =>
      this._fetch(`${this.url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "call",
          params,
          id: Date.now(),
        }),
        signal: AbortSignal.timeout(this._timeoutMs),
      }),
    );
    if (request_error) {
      throw new OdooTransportError(
        `Odoo did not answer ${path}: ${request_error.message}`,
        undefined,
        { cause: request_error },
      );
    }
    if (!response.ok) {
      throw new OdooTransportError(
        `Odoo answered ${path} with HTTP ${response.status} ${response.statusText}`,
        response.status,
      );
    }
    const [body, body_parse_error] = await Try(
      () => response.json() as Promise<JsonRpcResponse<T>>,
    );
    if (body_parse_error) {
      throw new OdooTransportError(
        `Odoo answered ${path} with something that is not JSON`,
        response.status,
        { cause: body_parse_error },
      );
    }
    if (body.error) {
      throw new OdooRpcError(
        body.error.data?.message ?? body.error.message ?? "Odoo error",
        body.error.data?.name,
        body.error.code,
        body.error.data?.debug,
      );
    }
    return { result: body.result as T, response };
  }

  private _sessionHeaders(): Record<string, string> {
    if (!this._session_id) {
      throw new OdooAuthenticationError(
        "No Odoo session. Call connect() first.",
      );
    }
    return {
      "X-Openerp-Session-Id": this._session_id,
      Cookie: `session_id=${this._session_id}`,
    };
  }

  //Connects to the Odoo server using an API key.
  private async _connectWithApiKey() {
    const config = this._config as ConnectionWithApiKeyCredentials;
    const { result } = await this._post<number | false>("/jsonrpc", {
      service: "common",
      method: "authenticate",
      args: [config.db, config.username, config.apiKey, {}],
    });
    if (typeof result !== "number") {
      throw new OdooAuthenticationError(
        `Odoo refused the API key of ${config.username} on database ${config.db}`,
      );
    }
    this._uid = result;
    const out: OdooAuthenticateWithApiKeyResponse = { uid: result };
    return out;
  }

  //Connects to the Odoo server using username and password credentials.
  private async _connectWithCredentials() {
    const config = this._config as ConnectionWithPasswordCredentials;
    const { result, response } =
      await this._post<OdooAuthenticateWithCredentialsResponse>(
        "/web/session/authenticate",
        { db: config.db, login: config.username, password: config.password },
      );
    const sessionId = response.headers
      .get("set-cookie")
      ?.split(";")
      .find((cookie) => cookie.trim().startsWith("session_id="))
      ?.split("=")[1];
    if (!result?.uid || !sessionId) {
      throw new OdooAuthenticationError(
        `Odoo refused the password of ${config.username} on database ${config.db}`,
      );
    }
    this._session_id = sessionId;
    this._auth_response = result;
    return result;
  }

  //Connects to the Odoo server using an existing session ID.
  private async _connectWithSessionId() {
    const { result } = await this._post<OdooAuthenticateWithCredentialsResponse>(
      "/web/session/get_session_info",
      {},
      this._sessionHeaders(),
    );
    if (!result?.uid) {
      throw new OdooAuthenticationError("The Odoo session has expired.");
    }
    this._auth_response = result;
    return result;
  }

  //Calls a method on the Odoo server using UID and API key authentication.
  private async _callWithUid<T>(
    model: string,
    method: string,
    args: PrimitiveOrObject[],
    kwargs: FObject = {},
  ) {
    const { result } = await this._post<T>("/jsonrpc", {
      service: "object",
      method: "execute_kw",
      args: [
        this._config.db,
        this._uid ?? null,
        this._api_key ?? null,
        model,
        method,
        args,
        kwargs,
      ],
    });
    return result;
  }

  //Calls a method on the Odoo server using session ID authentication.
  private async _callWithSessionId<T>(
    model: string,
    method: string,
    args: PrimitiveOrObject[],
    kwargs: FObject = {},
  ) {
    const { result } = await this._post<T>(
      "/web/dataset/call_kw",
      { model, method, args, kwargs },
      this._sessionHeaders(),
    );
    return result;
  }

  //
  //
  //

  constructor(config: OdooConnection, options: OdooClientOptions = {}) {
    this._config = config;
    this._fetch = options.fetch ?? globalThis.fetch;
    this._timeoutMs = options.timeoutMs ?? 30_000;
    this._initialize();
  }

  ///

  get uId() {
    return this._uid ?? this._auth_response?.uid;
  }
  get authResponse() {
    return this._auth_response;
  }
  get sessionId() {
    return this._session_id;
  }
  get port() {
    return this._config.port ? Number(this._config.port) : this._config.port;
  }

  ///

  //Connects to the Odoo server using the provided or existing configuration.
  async connect() {
    const result = await ("sessionId" in this._config
      ? this._connectWithSessionId()
      : "apiKey" in this._config
        ? this._connectWithApiKey()
        : this._connectWithCredentials());


    //
    if (!isCredentialsResponse(result)) {
      this._uid = result.uid;
    }

    //
    this._auth_response = result;
    this.is_connected = true;

    //
    return result;
  }

  //Calls a method on the Odoo server using the RPC protocol.
  async call_kw<T>(
    model: string,
    method: string,
    args: PrimitiveOrObject[],
    kwargs: FObject = {},
  ) {
    if (!this.is_connected) {
      this._auth_response = await this.connect();
    }

    if (this._session_id) {
      return this._callWithSessionId<T>(model, method, args, kwargs);
    } else if (this._uid) {
      return this._callWithUid<T>(model, method, args, kwargs);
    }

    this.is_connected = false;
    throw new OdooAuthenticationError(
      "Not connected to Odoo. Connect with a password, an API key or a session.",
    );
  }

  //Creates a new record in the specified Odoo model.
  async create(model: string, values: FObject) {
    return this.call_kw<number>(model, "create", [values]);
  }

  //Reads records from the specified Odoo model.
  async read<T>(model: string, id: number | number[], fields: string[]) {
    return this.call_kw<T>(model, "read", [id, fields]);
  }

  //Updates a record in the specified Odoo model.
  async update(model: string, id: number, values: FObject) {
    return this.call_kw<boolean>(model, "write", [[id], values]);
  }

  /**
   * Updates the translations for a field in the specified Odoo model.
   * @param model Model to update eg. product.template
   * @param id Id of the model to update
   * @param field field to update eg. name
   * @param translations object with translations eg. {de_DE: "Neuer Name", en_GB: "Name"}
   */
  async updateFieldTranslations(
    model: string,
    id: number,
    field: string,
    translations: { [key: string]: string },
  ) {
    return this.call_kw<boolean>(model, "update_field_translations", [
      [id],
      field,
      translations,
    ]);
  }

  //Deletes a record from the specified Odoo model.
  async delete(model: string, id: number) {
    return this.call_kw<boolean>(model, "unlink", [[id]]);
  }

  //Searches and reads records from the specified Odoo model.
  async searchRead<T extends FObject>(
    model: string,
    domain: OdooSearchDomain,
    fields: string[],
    opts?: OdooSearchReadOptions,
  ) {
    return (
      ((await this.call_kw(
        model,
        "search_read",
        [domain, fields],
        opts,
      )) as T[]) || []
    );
  }

  //Searches for records in the specified Odoo model.
  async search(model: string, domain: OdooSearchDomain) {
    return (await this.call_kw<number[]>(model, "search", [domain])) || [];
  }

  //Retrieves the fields information for the specified Odoo model.
  async getFields(model: string) {
    return this.call_kw(model, "fields_get", []);
  }

  //Executes an action on the specified Odoo model for given record IDs.
  async action(model: string, action: string, ids: number[]) {
    return this.call_kw<boolean>(model, action, ids);
  }

  //Creates an external ID for a record in the specified Odoo model.
  async createExternalId(
    model: string,
    recordId: number,
    externalId: string,
    moduleName?: string,
  ) {
    return await this.call_kw<number>("ir.model.data", "create", [
      [
        {
          model: model,
          name: `${externalId}`,
          res_id: recordId,
          module: moduleName || "__api__",
        },
      ],
    ]);
  }

  //Finds the ir.model.data row of an external ID, written `module.name` or just `name`.
  private async _externalId(externalId: string) {
    const dot = externalId.indexOf(".");
    const domain =
      dot === -1
        ? [["name", "=", externalId]]
        : [
            ["module", "=", externalId.slice(0, dot)],
            ["name", "=", externalId.slice(dot + 1)],
          ];
    const [row] = await this.searchRead<{ res_id: number; model: string }>(
      "ir.model.data",
      domain,
      ["res_id", "model"],
      { limit: 1 },
    );
    if (!row) {
      throw new OdooExternalIdNotFound(externalId);
    }
    return row;
  }

  //Searches for a record by its external ID.
  async searchByExternalId(externalId: string) {
    return (await this._externalId(externalId)).res_id;
  }

  //Reads a record by its external ID.
  async readByExternalId<T>(
    externalId: string,
    fields: string[] = [],
  ): Promise<T> {
    const { model, res_id } = await this._externalId(externalId);
    return (await this.read<T[]>(model, [res_id], fields))[0] as T;
  }

  //Updates a record by its external ID.
  async updateByExternalId(externalId: string, params: FObject = {}) {
    const { model, res_id } = await this._externalId(externalId);
    return await this.update(model, res_id, params);
  }

  //Deletes a record by its external ID.
  async deleteByExternalId(externalId: string) {
    const { model, res_id } = await this._externalId(externalId);
    return await this.delete(model, res_id);
  }

  //Disconnects from the Odoo server
  async disconnect() {
    await this._post("/web/session/destroy", {}, this._sessionHeaders());
    this.is_connected = false;
    this._auth_response = undefined;
    this._uid = undefined;
    this._session_id = undefined;
    return true;
  }
}
