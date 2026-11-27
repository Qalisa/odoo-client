# @qalisa/odoo-client

Typed client for an Odoo server's JSON-RPC API. Formerly published as `@qalisa/odoo-cli`.

```ts
import { getOdooCli, OdooRpcError } from "@qalisa/odoo-client";

const odoo = await getOdooCli([
  { baseUrl: "https://odoo.example.com", db: "odoo1", username: "ivy", apiKey: process.env.ODOO_API_KEY! },
  { timeoutMs: 10_000 },
]);

const partnerId = await odoo.create("res.partner", { name: "Acme", is_company: true });
await odoo.createExternalId("res.partner", partnerId, "organization_abc", "ivy");
await odoo.searchByExternalId("ivy.organization_abc"); // partnerId
```

Sign in with an API key, a password, or an existing session id.

## Errors

| Class | When |
| --- | --- |
| `OdooAuthenticationError` | Odoo refused the database, login, password or API key, or the session expired |
| `OdooRpcError` | Odoo raised an exception; `odooName` is its class (e.g. `odoo.exceptions.AccessError`) |
| `OdooTransportError` | Odoo could not be reached, answered a non-2xx status or no JSON, or took longer than `timeoutMs` |
| `OdooExternalIdNotFound` | No record carries the external ID |

## Options

The second constructor argument takes `fetch` (to replace the global one, e.g. in tests) and `timeoutMs` (default 30 000).

## Development

```bash
pnpm test
```

Pushing to `main` with a new `version` in `package.json` publishes to npm.
