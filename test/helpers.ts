// Test doubles for what the Miniapp SDK provides at run time (DB handle, scope store, OpContext)
// and for the upstream engine services. Not product code.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import type { CrudAction } from "@opt2-tealbrick/spec/manifest";
import type { Caller, Db, OpContext, ScopeStore } from "@opt2-tealbrick/spec/sdk";
import { memorySecrets } from "../src/knowledge.ts";

export function memoryDb(): Db {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  return {
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => {
      const statement = raw.prepare(sql);
      return {
        run: (...params) => statement.run(...(params as never[])) as { changes: number; lastInsertRowid: number | bigint },
        get: (...params) => statement.get(...(params as never[])) as Record<string, unknown> | undefined,
        all: (...params) => statement.all(...(params as never[])) as Record<string, unknown>[],
      };
    },
    transaction: <T>(fn: () => T): T => {
      raw.exec("SAVEPOINT tx");
      try {
        const out = fn();
        raw.exec("RELEASE tx");
        return out;
      } catch (error) {
        raw.exec("ROLLBACK TO tx");
        raw.exec("RELEASE tx");
        throw error;
      }
    },
  };
}

const ACCESS: Record<string, CrudAction[]> = { read: ["read"], read_write: ["read", "create", "update", "delete"] };

/** Minimal scope store with the manifest's default grants (own → read_write, shared → read). */
export class FakeScopes {
  instances: ScopeStore["instances"];
  private readonly rows = new Map<string, string>();
  private readonly list: { type: string; id: string; label: string; shared: boolean; owner?: string }[] = [];

  constructor() {
    this.instances = {
      create: async (type, id, label, opts) => {
        if (!this.list.some((item) => item.id === id)) this.list.push({ type, id, label, shared: Boolean(opts?.shared), owner: opts?.ownerAgent });
        return { type, id, label, shared: Boolean(opts?.shared) };
      },
      list: async (type) => this.list.filter((item) => item.type === type).map(({ owner: _o, ...rest }) => rest),
    };
  }

  applyDefaults(agentId: string) {
    for (const item of this.list) {
      if (item.owner === agentId) this.rows.set(`${agentId}|${item.id}`, "read_write");
      else if (item.shared && !this.rows.has(`${agentId}|${item.id}`)) this.rows.set(`${agentId}|${item.id}`, "read");
    }
  }

  set(agentId: string, area: string, access: string | null) {
    if (access) this.rows.set(`${agentId}|${area}`, access);
    else this.rows.delete(`${agentId}|${area}`);
  }

  asStore(): ScopeStore {
    return { instances: this.instances } as unknown as ScopeStore;
  }

  view(agentId: string): OpContext["scope"] {
    const level = (area: string) => this.rows.get(`${agentId}|${area}`);
    return {
      access: null,
      readable: async () => this.list.filter((item) => level(item.id)).map((item) => item.id),
      writable: async () => this.list.filter((item) => level(item.id) === "read_write").map((item) => item.id),
      can: async (_type, id, crud) => (ACCESS[level(id) ?? ""] ?? []).includes(crud),
    };
  }
}

export class TestError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus = 500) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function context(db: Db, scopes: FakeScopes, agentId: string, extra: Partial<OpContext> = {}): OpContext {
  const caller: Caller = { type: "agent", id: agentId as `agt_${string}`, name: agentId, mode: "free" };
  const noop = () => undefined;
  return {
    caller,
    grant: null,
    op: null as unknown as OpContext["op"],
    scope: scopes.view(agentId),
    callId: null,
    idempotencyKey: null,
    context: {},
    receipt: { summary: noop, meta: noop },
    getKey: async () => null,
    callApp: async () => {
      throw new Error("no companions");
    },
    callServiceHelper: async () => ({}) as never,
    db,
    log: { debug: noop, info: noop, warn: noop, error: noop },
    signal: new AbortController().signal,
    publicUrl: null,
    workspace: "ws_01TESTWORKSPACE0000000000000" as `ws_${string}`,
    scopes: scopes.asStore(),
    secrets: memorySecrets(),
    statusChanged: noop,
    ownerLink: () => null,
    ...extra,
  };
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export interface FakeGBrain {
  url: string;
  adminToken: string;
  sources: Set<string>;
  /** source → slug → page */
  pages: Map<string, Map<string, { content: string; revision: string }>>;
  calls: { source: string; name: string; args: Record<string, unknown> }[];
  /** override a tool's answer: return undefined to fall through */
  answer?: (source: string, name: string, args: Record<string, unknown>) => unknown;
  /**
   * How `query` answers (QA F88): `fake` = one `{results}` text item; `upstream-degraded` = byte-for-byte the framing of
   * a REAL upstream 0.60.57.0 keyless answer (test/fixtures/gbrain-replies/query-degraded-0.60.57.0.json: bare row
   * array, then a `[gbrain notice degraded_recall …]` block, `_meta.gbrain_notices` and `_meta.retrieval.degraded`) with
   * this fake's rows; `unparsable` = a text item that is not a row list.
   */
  queryReply?: "fake" | "upstream-degraded" | "unparsable";
  close(): Promise<void>;
}

/** A real upstream GBrain 0.60.57.0 answer to `query` on a keyless brain over HTTP (captured from the pinned upstream). */
export const UPSTREAM_DEGRADED_QUERY: unknown = JSON.parse(readFileSync(new URL("./fixtures/gbrain-replies/query-degraded-0.60.57.0.json", import.meta.url), "utf8"));

/** A small stand-in for `gbrain serve --http`: admin login, client registration, client_credentials tokens, stateless MCP. */
export async function fakeGBrain(): Promise<FakeGBrain> {
  const adminToken = "a".repeat(40);
  const clients = new Map<string, { secret: string; source: string }>();
  const tokens = new Map<string, string>();
  let counter = 0;
  const state: Omit<FakeGBrain, "url" | "close"> = { adminToken, sources: new Set(), pages: new Map(), calls: [] };
  const server: Server = createServer(async (req, res) => {
    const text = await body(req);
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/health") return json(200, { status: "ok", version: "0.60.57.0", engine: "postgres" });
    if (req.url === "/admin/login") return JSON.parse(text).token === adminToken ? json(200, { ok: true }, { "set-cookie": "gbrain_admin=s1; Path=/" }) : json(401, {});
    if (req.url === "/admin/api/register-client") {
      if (req.headers.cookie !== "gbrain_admin=s1") return json(401, {});
      const { source } = JSON.parse(text);
      if (!state.sources.has(source)) return json(400, { error: "unknown_source" });
      const clientId = `c${++counter}`;
      clients.set(clientId, { secret: `s${counter}`, source });
      return json(200, { clientId, clientSecret: `s${counter}` });
    }
    if (req.url === "/token") {
      const form = new URLSearchParams(text);
      const client = clients.get(form.get("client_id") ?? "");
      if (!client || client.secret !== form.get("client_secret")) return json(401, {});
      const token = `t${++counter}`;
      tokens.set(token, client.source);
      return json(200, { access_token: token, expires_in: 3600 });
    }
    if (req.url === "/mcp") {
      const source = tokens.get((req.headers.authorization ?? "").replace(/^Bearer /u, ""));
      if (!source) return json(401, {});
      const message = JSON.parse(text);
      const reply = (result: unknown) => json(200, { jsonrpc: "2.0", id: message.id, result });
      const toolError = (error: string) => reply({ isError: true, content: [{ type: "text", text: JSON.stringify({ error, message: "secret detail" }) }] });
      if (message.method === "tools/list") {
        return reply({
          tools: ["query", "remember", "forget", "get_page", "entity", "sources_list"].map((name) => ({
            name,
            description: `${name} tool`,
            inputSchema: { type: "object", properties: { source_id: { type: "string" }, query: { type: "string" } }, required: ["source_id"] },
          })),
        });
      }
      const { name, arguments: args } = message.params as { name: string; arguments: Record<string, unknown> };
      state.calls.push({ source, name, args });
      const custom = state.answer?.(source, name, args);
      if (custom !== undefined) return reply({ content: [{ type: "text", text: JSON.stringify(custom) }] });
      const pages = state.pages.get(source) ?? new Map();
      state.pages.set(source, pages);
      // Upstream validateSlug lower-cases every slug (gbrain src/core/utils.ts at the pin); the fake does the same.
      const slug = String(args.slug ?? "").toLowerCase();
      if (name === "get_page") {
        const page = pages.get(slug);
        return page ? reply({ content: [{ type: "text", text: JSON.stringify({ slug, revision: page.revision, content: page.content }) }] }) : toolError("page_not_found");
      }
      if (name === "put_page") {
        const page = pages.get(slug);
        if (page && args.expected_revision !== page.revision) return toolError("revision_conflict");
        pages.set(slug, { content: String(args.content), revision: `r${++counter}` });
        return reply({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }] });
      }
      if (name === "delete_page") {
        pages.delete(slug);
        return reply({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }] });
      }
      if (name === "query") {
        const words = String(args.query).toLowerCase().split(/\s+/u);
        const results = [...pages.entries()]
          .filter(([, page]) => words.some((word) => page.content.toLowerCase().includes(word)))
          .map(([pageSlug, page], i) => ({ slug: pageSlug, title: pageSlug, chunk_text: page.content.slice(-200), score: 1 - i / 10, source_id: source }));
        if (state.queryReply === "unparsable") return reply({ content: [{ type: "text", text: "search backend restarting" }, { type: "text", text: "[gbrain notice degraded_recall kind=degraded]\nwhy: x" }] });
        if (state.queryReply === "upstream-degraded") {
          const real = UPSTREAM_DEGRADED_QUERY as { content: { type: string; text: string }[]; _meta: Record<string, unknown> };
          const template = (JSON.parse(real.content[0]?.text ?? "[]") as Record<string, unknown>[])[0] ?? {};
          const rows = results.map((row) => ({ ...template, ...row }));
          return reply({ content: [{ type: "text", text: JSON.stringify(rows) }, ...real.content.slice(1)], _meta: real._meta });
        }
        return reply({ content: [{ type: "text", text: JSON.stringify({ results }) }] });
      }
      return reply({ content: [{ type: "text", text: JSON.stringify({ ok: true, name }) }] });
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}
