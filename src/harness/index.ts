import { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { AgentRegistry } from "./adapters/registry";
import { OAuthBroker } from "./auth/broker";
import { NativeAuthManager } from "./auth/native";
import { getHarnessConfig } from "./config";
import { HarnessStore } from "./db/store";
import { DispatcherLoop } from "./dispatcher/loop";
import { StageRunner } from "./runtime/executor";
import { registerHarnessRoutes } from "./api/routes";

export async function registerHarness(app: FastifyInstance, repoRoot: string): Promise<void> {
  await app.register(multipart, {
    limits: {
      fileSize: 20 * 1024 * 1024,
      files: 1,
    },
  });

  const config = getHarnessConfig(repoRoot);
  if (!config.enabled) {
    return;
  }

  const store = new HarnessStore(repoRoot, config);
  const registry = new AgentRegistry();
  const nativeAuth = new NativeAuthManager(repoRoot);
  const broker = new OAuthBroker({
    store,
    callbackBaseUrl: `http://${config.oauthCallbackHost}:${config.oauthCallbackPort}`,
    encryptionSecret: config.oauthEncryptionKey,
  });
  const runner = new StageRunner(config, registry);
  const dispatcher = new DispatcherLoop(store, runner, registry, broker, nativeAuth, config);

  await registerHarnessRoutes(app, {
    config,
    store,
    dispatcher,
    registry,
    broker,
    nativeAuth,
  });
}
