// One real embedding call through GBrain's own gateway, with the key and address the engine runs with (boot.ts runs this with
// the engine's env, under bun, like GBrain itself). Prints one JSON line (embed-cause.ts EmbedCheck), never upstream text.
// A failed call is sampled once: no retries (the same rule as `gbrain doctor`).
import { classifyEmbedFailure, type EmbedCheck } from "./embed-cause.ts";

const root = process.env.GBRAIN_ROOT ?? "/opt/gbrain";
const at = () => new Date().toISOString();

async function check(): Promise<EmbedCheck> {
  const { loadConfig } = await import(`${root}/src/core/config.ts`);
  const { buildGatewayConfig } = await import(`${root}/src/core/ai/build-gateway-config.ts`);
  const gateway = await import(`${root}/src/core/ai/gateway.ts`);
  const config = loadConfig();
  if (!config) return { result: "not_ready", at: at() };
  gateway.configureGateway(buildGatewayConfig(config));
  if (!gateway.diagnoseEmbedding().ok) return { result: "not_ready", at: at() };
  try {
    await gateway.embedOne("knowledge embedding check", { maxRetries: 0, inputType: "query", abortSignal: AbortSignal.timeout(20_000) });
    return { result: "ok", at: at() };
  } catch (err) {
    return { result: "failed", ...classifyEmbedFailure(err), at: at() };
  }
}

const out = await check().catch((err: unknown): EmbedCheck => ({ result: "failed", ...classifyEmbedFailure(err), at: at() }));
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
