import { researchAgent } from "./research-agent";
import { weatherAgent } from "./weather-agent";

// Specialists the orchestrator can delegate to. To add one:
// 1. Create its agent file with a `description` that says what it does,
//    what input it needs, what it returns, and what it does not do.
// 2. Add it to this object. The orchestrator prompt, delegation tool
//    (`agent-<key>`), and Mastra registration pick it up from here.
export const team = { researchAgent, weatherAgent };
