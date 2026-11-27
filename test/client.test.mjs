import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OdooAuthenticationError,
  OdooExternalIdNotFound,
  OdooJSONRpc,
  OdooRpcError,
  OdooTransportError,
} from "../dist/index.js";

const config = {
  baseUrl: "https://odoo.test",
  db: "odoo1",
  username: "ivy",
  apiKey: "key",
};

const odoo = (answer, calls = []) =>
  new OdooJSONRpc(config, {
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body.params);
      const reply = answer(body.params, url);
      return reply instanceof Response ? reply : Response.json(reply);
    },
  });

const authenticated = (then) => (params, url) =>
  params.service === "common" ? { result: 7 } : then(params, url);

test("a refused API key fails at connect instead of passing silently", async () => {
  await assert.rejects(
    odoo(() => ({ result: false })).connect(),
    OdooAuthenticationError,
  );
});

test("an Odoo exception keeps its class and message", async () => {
  const client = odoo(
    authenticated(() => ({
      error: {
        code: 200,
        message: "Odoo Server Error",
        data: { name: "odoo.exceptions.AccessError", message: "Not allowed" },
      },
    })),
  );

  const error = await client.create("res.partner", { name: "Acme" }).catch((e) => e);

  assert.ok(error instanceof OdooRpcError);
  assert.equal(error.odooName, "odoo.exceptions.AccessError");
  assert.equal(error.message, "Not allowed");
});

test("an HTTP failure is a transport error with its status", async () => {
  const error = await odoo(() => new Response("bad gateway", { status: 502 }))
    .connect()
    .catch((e) => e);

  assert.ok(error instanceof OdooTransportError);
  assert.equal(error.status, 502);
});

test("a module-qualified external ID searches by module and name", async () => {
  const calls = [];
  const client = odoo(
    authenticated(() => ({ result: [{ res_id: 42, model: "res.partner" }] })),
    calls,
  );

  assert.equal(await client.searchByExternalId("ivy.organization_abc"), 42);
  assert.deepEqual(calls.at(-1).args[5][0], [
    ["module", "=", "ivy"],
    ["name", "=", "organization_abc"],
  ]);
});

test("a missing external ID is a named error", async () => {
  const client = odoo(authenticated(() => ({ result: [] })));

  await assert.rejects(
    client.searchByExternalId("ivy.organization_missing"),
    OdooExternalIdNotFound,
  );
});
