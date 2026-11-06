// INC-20261104-01 (0.1.36): services/notebook/ipv6-forward.ts gives an IPv4-only server (upstream's API on 0.0.0.0) an
// IPv6 listener on the SAME port, without taking the IPv4 side (Railway's health check probes over IPv4).
import assert from "node:assert/strict";
import { connect, createServer, type Server } from "node:net";
import { after, test } from "node:test";
import { startForward } from "../services/notebook/ipv6-forward.ts";

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

/** one request over TCP: send `ping`, read the reply */
function ask(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = connect({ host, port }, () => c.write("ping"));
    let got = "";
    c.on("data", (d) => {
      got += d.toString();
      c.end();
    });
    c.on("close", () => resolve(got));
    c.on("error", reject);
  });
}

test("an IPv4-only upstream answers over ::1 through the forwarder on the same port, and still over 127.0.0.1 directly", async () => {
  const upstream = createServer((s) => s.on("data", (d) => s.end(`v4-upstream:${d}`)));
  servers.push(upstream);
  await new Promise<void>((ok) => upstream.listen({ host: "0.0.0.0", port: 0 }, ok));
  const port = (upstream.address() as { port: number }).port;

  // before the forwarder: IPv6 is refused (the bug)
  await assert.rejects(ask("::1", port), (e: NodeJS.ErrnoException) => e.code === "ECONNREFUSED");

  const fwd = await startForward({ listenPort: port, targetHost: "127.0.0.1", targetPort: port });
  servers.push(fwd);
  assert.equal(await ask("::1", port), "v4-upstream:ping");
  assert.equal(await ask("127.0.0.1", port), "v4-upstream:ping");
});

test("a dead upstream closes the IPv6 client connection instead of hanging", async () => {
  const probe = createServer();
  await new Promise<void>((ok) => probe.listen({ host: "127.0.0.1", port: 0 }, ok));
  const deadPort = (probe.address() as { port: number }).port;
  await new Promise<void>((ok) => probe.close(() => ok()));
  const fwd = await startForward({ listenPort: 0, targetHost: "127.0.0.1", targetPort: deadPort });
  servers.push(fwd);
  const port = (fwd.address() as { port: number }).port;
  assert.equal(await ask("::1", port), "");
});
