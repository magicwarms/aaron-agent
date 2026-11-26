import { Agent } from "@mastra/core/agent";
import { webFetchTool, webSearchTool } from "@mastra/core/tools";

export const researchAgent = new Agent({
  id: "research-agent",
  name: "Research Agent",
  // The orchestrator reads this description to decide when to delegate here.
  description:
    "Searches the web and reads pages to answer factual or current questions. Returns a short bullet summary with source URLs. Does not write long content or change files.",
  instructions: `You research questions using the web. ALWAYS find latest updated information.

1. Search first with web_search.
2. Open the most relevant pages with web_fetch when the snippets are not enough.
3. Answer with short bullet points. Put the source URL after each fact.
4. If you cannot find a reliable answer, say so. Do not guess.`,
  model: process.env.OPENAI_MODEL as string,
  tools: {
    web_fetch: webFetchTool,
    web_search: webSearchTool,
  },
});
