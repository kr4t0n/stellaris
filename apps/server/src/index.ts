import { serve } from "@hono/node-server";
import { loadServerConfig } from "@stellaris/shared";
import pino from "pino";
import { createApp } from "./app.js";

const VERSION = "0.0.0";

const config = loadServerConfig(process.env);
const log = pino({ level: config.logLevel });
const app = createApp({ version: VERSION });

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  log.info(
    { host: info.address, port: info.port, dataDir: config.dataDir },
    "board server listening",
  );
});
