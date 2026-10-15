import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  PROTOCOL_VERSION_META_KEY,
  CLIENT_INFO_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
} from "@modelcontextprotocol/server";
import { identity, ProjectStore, applyOperation, publicState, writeJson } from "../state.mjs";
import { buildHandoff } from "../handoffs.mjs";
import { startDashboard } from "../server.mjs";

const maximum = 1024 * 1024;
const taskId = "handoff-size-task";
const serialize = (value) => JSON.stringify(value, null, 2) + "\n";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-handoff-size-"));
  const project = { ...(await identity(root)), directory: path.join(root, "state") };
  const stateFile = path.join(project.directory, "state.json");
  const packetFile = path.join(project.directory, "handoff.json");
  let dashboard;
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await dashboard?.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true });
  });
  return {
    project, stateFile, packetFile, clients,
    async start() {
      const probe = net.createServer();
      await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
      const port = probe.address().port;
      await new Promise((resolve) => probe.close(resolve));
      dashboard = await startDashboard({
        project, port, tailscale: false,
        webhookPost: async () => { throw new Error("Unexpected fixture webhook"); },
        observeExternalCli: async () => { throw new Error("Unexpected fixture CLI"); },
      });
      const runtime = JSON.parse(await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"));
      const headers = { authorization: `Bearer ${runtime.mcp_token}`, "content-type": "application/json" };
      return {
        dashboard,
        async http(route, input) {
          const response = await fetch(dashboard.localUrl + route, {
            headers,
            ...(input === undefined ? {} : { method: "POST", body: JSON.stringify(input) }),
          });
          return { status: response.status, body: await response.json() };
        },
        async legacy() {
          const client = new Client({ name: "handoff-size-test", version: "1" }, { capabilities: {} });
          clients.push(client);
          await client.connect(new StreamableHTTPClientTransport(new URL(dashboard.localUrl + "mcp"), { requestInit: { headers } }));
          return client;
        },
        async modern(method, params) {
          const response = await fetch(dashboard.localUrl + "mcp", {
            method: "POST",
            headers: { ...headers, accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": method, "mcp-name": params.name || params.uri },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { [PROTOCOL_VERSION_META_KEY]: "2026-07-28", [CLIENT_INFO_META_KEY]: { name: "handoff-size-test", version: "1" }, [CLIENT_CAPABILITIES_META_KEY]: {} } } }),
          });
          assert.equal(response.status, 200);
          const result = await response.json();
          assert.equal(result.error, undefined, JSON.stringify(result));
          return result.result;
        },
      };
    },
  };
}

function consultation(state, id, question, answer) {
  applyOperation(state, "question", { id, question, decision: { kind: "consultation", target: { task_id: taskId, revision: "fixture-v1" } } });
  const card = state.question_contracts.cards[id];
  applyOperation(state, "answer", { id, answer, expected_revision: card.revision, contract_fingerprint: card.fingerprint });
}

test("oversize creation preserves the existing packet and state through HTTP and both MCP transports", async (t) => {
  const f = await fixture(t);
  const api = await f.start();
  await api.dashboard.mutate("task", { id: taskId, title: "引継ぎ", status: "doing" });
  const small = await api.http("api/handoff/create", { task_id: taskId });
  assert.equal(small.status, 200);
  const savedPacket = await fs.readFile(f.packetFile);
  const next = api.dashboard.store.clone();
  for (let i = 0; i < 25; i++) consultation(next, "Q" + i, "問".repeat(8000), "答".repeat(8000));
  await api.dashboard.store.commit(next);
  const beforeState = await fs.readFile(f.stateFile);
  const beforeRevision = api.dashboard.store.value.revision;
  const oversized = buildHandoff(publicState(next), taskId, null);
  assert(Buffer.byteLength(serialize(oversized)) > maximum);
  const rejected = await api.http("api/handoff/create", { task_id: taskId });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /Handoff packet exceeds the size limit/);
  const client = await api.legacy();
  const legacyRejected = await client.callTool({ name: "dashboard_create_handoff", arguments: { task_id: taskId } });
  assert.equal(legacyRejected.isError, true);
  assert.match(legacyRejected.content[0].text, /Handoff packet exceeds the size limit/);
  const modernRejected = await api.modern("tools/call", { name: "dashboard_create_handoff", arguments: { task_id: taskId } });
  assert.equal(modernRejected.isError, true);
  assert.match(modernRejected.content[0].text, /Handoff packet exceeds the size limit/);
  assert.equal(api.dashboard.store.value.revision, beforeRevision);
  assert.deepEqual(await fs.readFile(f.stateFile), beforeState);
  assert.deepEqual(await fs.readFile(f.packetFile), savedPacket);
  assert.equal((await api.http("api/handoff")).body.packet_id, small.body.packet_id);
  assert.equal((await api.http("api/acceptance")).status, 200);
  for (const result of [
    await client.callTool({ name: "dashboard_get_handoff", arguments: {} }),
    await api.modern("tools/call", { name: "dashboard_get_handoff", arguments: {} }),
  ]) assert.equal(JSON.parse(result.content[0].text).packet_id, small.body.packet_id);
  for (const uri of ["dashboard://handoff", "dashboard://acceptance"]) {
    for (const result of [await client.readResource({ uri }), await api.modern("resources/read", { uri })]) {
      const packet = JSON.parse(result.contents[0].text);
      if (uri === "dashboard://handoff") assert.equal(packet.packet_id, small.body.packet_id);
      else assert.equal(packet.acceptance_defined, false);
    }
  }
});

async function sizedState(project, targetBytes) {
  const initial = (await ProjectStore.open(project)).value;
  function make(extra) {
    const state = structuredClone(initial);
    state.revision = 9;
    applyOperation(state, "task", { id: taskId, title: "Boundary", status: "doing" });
    function text() {
      const japanese = Math.min(8000, Math.floor(extra / 2));
      extra -= japanese * 2;
      const accent = japanese < 8000 && extra > 0 ? 1 : 0;
      extra -= accent;
      return "問".repeat(japanese) + "é".repeat(accent) + "a".repeat(8000 - japanese - accent);
    }
    for (let i = 0; i < 25; i++) consultation(state, "Q" + i, text(), text());
    assert.equal(extra, 0);
    return state;
  }
  function predictedBytes(state) {
    const packet = buildHandoff(publicState(state), taskId, null);
    packet.snapshot_revision = 10;
    return Buffer.byteLength(serialize(packet));
  }
  const plain = make(0);
  const state = make(targetBytes - predictedBytes(plain));
  assert.equal(predictedBytes(state), targetBytes);
  return state;
}

for (const offset of [-1, 0, 1]) {
  test(`serialized UTF-8 packet at 1 MiB ${offset < 0 ? "minus 1 byte" : offset > 0 ? "plus 1 byte" : "exactly"} uses the committed revision`, async (t) => {
    const f = await fixture(t);
    await writeJson(f.stateFile, await sizedState(f.project, maximum + offset));
    const api = await f.start();
    const before = await fs.readFile(f.stateFile);
    const response = await api.http("api/handoff/create", { task_id: taskId });
    if (offset > 0) {
      assert.equal(response.status, 400);
      assert.equal(api.dashboard.store.value.revision, 9);
      assert.deepEqual(await fs.readFile(f.stateFile), before);
      await assert.rejects(fs.access(f.packetFile), { code: "ENOENT" });
    } else {
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.snapshot_revision, 10);
      assert.equal((await fs.readFile(f.packetFile)).length, maximum + offset);
      assert.equal((await api.http("api/handoff")).status, 200);
      assert.equal((await api.http("api/acceptance")).status, 200);
    }
  });
}
