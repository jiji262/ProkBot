import { cp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSelfHostServer } from "../server/index.mjs";
import { internalCredential } from "./credentials.mjs";
import { HostSupervisor } from "./host-supervisor.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const data = resolve(process.env.GROKBOT_DATA_DIR ?? "/data");
const state = resolve(process.env.GROKBOT_STATE_DIR ?? join(data, "runtime"));
const modelFile = resolve(
  process.env.GROKBOT_MODEL_ENV ?? join(data, "model.env"),
);
const tokenFile = resolve(
  process.env.GROKBOT_INTERNAL_HOST_TOKEN_FILE ??
    join(data, "internal-host-token"),
);
const hostUrl =
  process.env.GROKBOT_INTERNAL_HOST_URL ??
  `http://127.0.0.1:${process.env.GROKBOT_HOST_PORT ?? 1340}`;
Object.assign(process.env, {
  GROKBOT_DATA_DIR: data,
  GROKBOT_STATE_DIR: state,
  GROKBOT_MODEL_ENV: modelFile,
  GROKBOT_INTERNAL_HOST_TOKEN_FILE: tokenFile,
  GROKBOT_HOST_DATA_DIR: join(state, "host-data"),
  GROKBOT_INTERNAL_HOST_URL: hostUrl,
  GROKBOT_CONNECTORS_URL: process.env.GROKBOT_CONNECTORS_URL ??
    `http://127.0.0.1:${process.env.GROKBOT_PORT ?? 8000}/internal/connectors`,
  GROKBOT_SPEECH_URL: process.env.GROKBOT_SPEECH_URL ??
    `http://127.0.0.1:${process.env.GROKBOT_PORT ?? 8000}/internal/audio/transcriptions`,
  GROKBOT_NATIVE_DESKTOP_URL: `http://127.0.0.1:${process.env.GROKBOT_PORT ?? 8000}/internal/desktop-capabilities`,
  GROKBOT_HOST_BIND: process.env.GROKBOT_HOST_BIND ?? "127.0.0.1",
});
await mkdir(data, { recursive: true, mode: 0o700 });
await mkdir(state, { recursive: true, mode: 0o700 });
const internalToken = await internalCredential(tokenFile, { create: true });
// Only image-owned generated files are refreshed. User data and credentials never come from the image.
for (const entry of [
  "blob-worker-library-provenance.json",
  "blob-worker-library.cjs",
  "host-library-provenance.json",
  "host-library.cjs",
  "recovered-core",
  "recovered-worker",
]) {
  await cp(join(root, "seed", entry), join(state, entry), {
    recursive: true,
    force: true,
  });
}
let supervisor;
const service = await createSelfHostServer({
  computers: () => supervisor?.getComputers() ?? { available: false, computers: [] },
});
const address = await service.start();
console.log(
  `[supervisor] administration listening on ${address.port}${service.auth.initialized ? "" : `; initialization key file: ${join(data, "setup-key")}`}`,
);
supervisor = new HostSupervisor({
  dataDir: data,
  hostUrl,
  internalToken,
  entry: join(root, "runtime/host.mjs"),
  env: process.env,
  isConfigured: async () => {
    const model = await service.models.current();
    return Boolean(model.baseUrl && model.apiKey && model.model) &&
      (process.env.GROKBOT_REQUIRE_EXECUTION_NODE !== '1' || service.executionNode.store.value.config.enabled);
  },
}).start();
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    if (stopping) return;
    stopping = true;
    await supervisor.stop();
    await service.close();
  });
