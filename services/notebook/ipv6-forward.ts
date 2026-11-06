// INC-20261104-01 (0.1.36): the IPv6 path to the Open Notebook API.
// Upstream's API (uvicorn) listens on 0.0.0.0:5055, IPv4 only. Railway's health check reaches it over IPv4, so it must
// stay there: in 0.1.35 the API listened on "::" (IPv6 only, asyncio sets IPV6_V6ONLY), the IPv4 health check was
// refused and Railway failed the deploy after 300 s. On a Railway project with an IPv6-only private network the
// Knowledge app reaches the API over IPv6, so this forwarder listens on [::]:5055 with IPV6_V6ONLY (an IPv4 socket and
// an IPv6-only socket share one port on Linux; proven in the pinned image) and pipes each connection to 127.0.0.1:5055.
// Plain TCP: it reads nothing, logs one line at start and one on a listen failure, never request data.
import { connect, createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";

export interface ForwardOptions {
  /** IPv6 port to listen on (IPv6 only) */
  listenPort: number;
  /** the IPv4 upstream */
  targetHost: string;
  targetPort: number;
}

function log(fields: Record<string, string | number>): void {
  console.error(JSON.stringify({ ts: new Date().toISOString(), component: "notebook-v6-forward", ...fields }));
}

/** Listen on [::]:listenPort (IPv6 only) and pipe every connection to targetHost:targetPort. Resolves once listening. */
export function startForward(o: ForwardOptions): Promise<Server> {
  const server = createServer((client) => {
    const upstream = connect({ host: o.targetHost, port: o.targetPort });
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end);
    upstream.on("error", end);
    client.on("close", end);
    upstream.on("close", end);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "::", port: o.listenPort, ipv6Only: true }, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.KNOWLEDGE_NOTEBOOK_API_PORT ?? 5055);
  startForward({ listenPort: port, targetHost: "127.0.0.1", targetPort: port }).then(
    () => log({ event: "listening", msg: `notebook ipv6 forwarder listening [::]:${port}`, host: "::", port, target: `127.0.0.1:${port}` }),
    (e: NodeJS.ErrnoException) => {
      log({ event: "listen_failed", msg: `notebook ipv6 forwarder cannot listen on [::]:${port}`, port, code: String(e.code ?? "error") });
      process.exit(1);
    },
  );
}
