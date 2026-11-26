import { Mastra } from "@mastra/core/mastra";
import { PinoLogger } from "@mastra/loggers";
import {
  Observability,
  MastraStorageExporter,
  MastraPlatformExporter,
  SensitiveDataFilter,
} from "@mastra/observability";
import { weatherWorkflow } from "./workflows/weather-workflow";
import { onboardingWorkflow } from "./workflows/onboarding-workflow";
import { MongoDBStore } from "@mastra/mongodb";
import { agent } from "./agents/agent";
import { team } from "./agents/team";

export const mastra = new Mastra({
  workflows: { weatherWorkflow, onboardingWorkflow },
  agents: { agent, ...team },
  storage: new MongoDBStore({
    id: "mongodb-storage",
    uri: process.env.MONGODB_URI,
    dbName: process.env.MONGODB_DB_NAME!,
  }),
  logger: new PinoLogger({
    name: "Mastra",
    level: "info",
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: "mastra",
        exporters: [
          new MastraStorageExporter(), // Persists observability events to Mastra Storage
          new MastraPlatformExporter(), // Sends observability events to Mastra Platform (if MASTRA_PLATFORM_ACCESS_TOKEN is set)
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
        ],
      },
    },
  }),
});
