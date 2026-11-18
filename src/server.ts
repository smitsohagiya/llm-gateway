import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { loadGatewayConfig } from "./config/gateway-config.js";

const env = loadEnv();
const app = buildApp({ env, config: loadGatewayConfig(env.GATEWAY_CONFIG) });

const shutdown = (): void => {
  app.log.info("shutting down");
  void app.close().then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error, "server failed to start");
  process.exit(1);
}
