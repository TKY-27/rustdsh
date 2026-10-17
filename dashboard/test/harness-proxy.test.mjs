import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { proxyHarness } from "../harness.mjs";

async function fixture(t, handler) {
  const upstream = http.createServer(handler);
  const front = http.createServer((req, res) =>
    proxyHarness(req, res, upstream.address().port, "rdsh_harness", "admin-key"),
  );
  for (const server of [upstream, front]) {
    t.after(() => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  }
  return `http://127.0.0.1:${front.address().port}/`;
}

for (const streaming of [false, true]) {
  test(`Harness proxy releases upstream after client disconnect (${streaming ? "streaming" : "waiting"})`, async (t) => {
    const accepted = Promise.withResolvers();
    const url = await fixture(t, (req, res) => {
      accepted.resolve(res);
      if (streaming) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": connected\n\n");
      }
    });
    const request = http.get(url);
    request.on("error", () => {});
    t.after(() => request.destroy());
    const incoming = streaming ? once(request, "response") : null;
    const upstream = await accepted.promise;
    const closed = once(upstream, "close", { signal: AbortSignal.timeout(5000) });
    if (streaming) {
      const [response] = await incoming;
      response.on("error", () => {});
      response.destroy();
    } else {
      request.destroy();
    }
    await closed;
    assert.equal(upstream.destroyed, true);
  });
}

test("Harness proxy terminates a truncated upstream response", async (t) => {
  const accepted = Promise.withResolvers();
  const url = await fixture(t, (req, res) => {
    res.writeHead(200, { "content-length": "100" });
    res.write("partial");
    accepted.resolve(res);
  });
  const request = http.get(url);
  t.after(() => request.destroy());
  const [response] = await once(request, "response");
  response.on("error", () => {});
  response.setEncoding("utf8");
  let body = "";
  response.on("data", (chunk) => { body += chunk; });
  await once(response, "data");
  const aborted = once(response, "aborted", { signal: AbortSignal.timeout(5000) });
  (await accepted.promise).destroy();
  await aborted;
  assert.equal(response.complete, false);
  assert.equal(response.readableEnded, false);
  assert.equal(body.includes("Harness is not available"), false);
});

test("Harness proxy preserves upstream keepalive after complete responses", async (t) => {
  const sockets = [];
  const url = await fixture(t, (req, res) => {
    sockets.push(req.socket);
    res.end("ok");
  });
  for (let i = 0; i < 2; i++) {
    const request = http.get(url);
    const [response] = await once(request, "response");
    assert.equal(response.statusCode, 200);
    response.resume();
    await once(response, "end");
  }
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0], sockets[1]);
  assert.equal(sockets[0].destroyed, false);
});

test("Harness proxy returns 502 when upstream closes before headers", async (t) => {
  const url = await fixture(t, (req, res) => res.destroy());
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 502);
  assert.equal(
    await response.text(),
    "Harness is not available; confirm it is running and retry",
  );
});
