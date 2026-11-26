/// <reference types="bun" />
// Runs the real agent with a scripted model and in-memory storage:
// no network, no API cost, no database.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";

// Set before importing the agent, so a real key from .env is never used.
process.env.OPENAI_API_KEY = "dummy";
process.env.OPENAI_MODEL = "openai/gpt-5.1";
// The agent workspace is relative to the current directory.
const startDirectory = process.cwd();
const scratchDirectory = mkdtempSync(join(tmpdir(), "aaron-test-"));
process.chdir(scratchDirectory);
afterAll(() => {
  process.chdir(startDirectory);
  rmSync(scratchDirectory, { recursive: true, force: true });
});

const { agent } = await import("../src/mastra/agents/agent");
const { team } = await import("../src/mastra/agents/team");

const ONBOARDING_TOOL = "workflow-onboardingWorkflow";

type ModelCall = { toolChoice?: { type: string; toolName?: string }; system: string };
const modelCalls: ModelCall[] = [];
let toolCallCount = 0;

const textOf = (message: any): string =>
  typeof message.content === "string"
    ? message.content
    : message.content.map((part: any) => part.text ?? "").join("");

// Behaves like an obedient model: calls a forced tool, then asks the user the
// question that the tool returned.
const scriptedReply = (options: any) => {
  const last = options.prompt.at(-1);
  if (options.toolChoice?.type === "tool") {
    const said = textOf(options.prompt.findLast((m: any) => m.role === "user"));
    return {
      call: {
        toolCallId: `call-${++toolCallCount}`,
        toolName: options.toolChoice.toolName,
        input: JSON.stringify({ inputData: { declined: said.includes("nanti saja") } }),
      },
    };
  }
  const question =
    last.role === "tool" ? last.content[0]?.output?.value?.result?.question : undefined;
  return { text: question ?? "ok" };
};

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model: any = {
  specificationVersion: "v2",
  provider: "test",
  modelId: "test",
  supportedUrls: {},
  async doGenerate() {
    return { content: [{ type: "text", text: "ok" }], warnings: [], finishReason: "stop", usage };
  },
  async doStream(options: any) {
    let reply: ReturnType<typeof scriptedReply> = { text: "ok" };
    // Calls without tools are title generation.
    if (options.tools?.length) {
      const system = options.prompt
        .filter((m: any) => m.role === "system")
        .map(textOf)
        .join("\n");
      modelCalls.push({ toolChoice: options.toolChoice, system });
      reply = scriptedReply(options);
    }
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (reply.call) {
            controller.enqueue({ type: "tool-call", ...reply.call });
          } else {
            controller.enqueue({ type: "text-start", id: "1" });
            controller.enqueue({ type: "text-delta", id: "1", delta: reply.text });
            controller.enqueue({ type: "text-end", id: "1" });
          }
          controller.enqueue({
            type: "finish",
            finishReason: reply.call ? "tool-calls" : "stop",
            usage,
          });
          controller.close();
        },
      }),
    };
  },
};

const mastra = new Mastra({
  agents: { agent, ...team },
  workflows: await agent.listWorkflows(),
  storage: new InMemoryStore(),
  logger: false,
});
for (const member of [agent, ...Object.values(team)] as any[]) {
  member.__updateModel({ model });
}

const memoryStore = (await mastra.getStorage()!.getStore("memory"))!;
const resourceOf = (resourceId: string) => memoryStore.getResourceById({ resourceId });

const forcedTool = () => modelCalls[0]?.toolChoice?.toolName;

// One chat turn through agent.stream(). Returns what the user would read.
const send = async (resource: string, thread: string, text: string) => {
  modelCalls.length = 0;
  const stream = await agent.stream(text, { memory: { thread, resource } });
  let reply = "";
  const problems: unknown[] = [];
  for await (const chunk of stream.fullStream as any) {
    if (chunk.type === "text-delta") reply += chunk.payload.text;
    if (["error", "tool-error", "tool-call-suspended"].includes(chunk.type)) problems.push(chunk);
  }
  expect(problems).toEqual([]);
  return reply;
};

// One chat turn the way Studio sends it: a user signal on the thread.
const signal = async (resource: string, thread: string, type: string, contents: string) => {
  modelCalls.length = 0;
  const sent: any = agent.sendSignal(
    { type, tagName: type === "user" ? "user" : "schedule", contents } as any,
    { resourceId: resource, threadId: thread },
  );
  const run = await sent.accepted;
  // "wake" means a new run took the message. A suspended run would only queue it.
  expect(run.action).toBe("wake");
  const reply = (await run.output.text) as string;
  // The thread is released shortly after the text is ready, as it is by the
  // time a person has typed their next message.
  await Bun.sleep(100);
  return reply;
};

// Sends the greeting, then one message per answer. Returns every reply.
const onboard = async (resource: string, answers: string[]) => {
  const replies = [await send(resource, `${resource}-t1`, "halo")];
  for (const answer of answers) {
    replies.push(await send(resource, `${resource}-t1`, answer));
  }
  return replies;
};

const ANSWERS = ["Andi", "Developer", "Membuat AI agent", "Bahasa Indonesia, singkat"];
const QUESTIONS = [/dipanggil/, /pekerjaan/, /tujuan/, /bahasa/];

describe("user onboarding", () => {
  test("a new user is asked first, whatever they said", async () => {
    const reply = await send("new-user", "new-user-t1", "Cuaca di Jakarta?");

    expect(forcedTool()).toBe(ONBOARDING_TOOL);
    expect(reply).toMatch(QUESTIONS[0]!);
    // After asking, the model may only talk: no more tool calls this turn.
    expect(modelCalls.map((call) => call.toolChoice?.type)).toEqual(["tool", "none"]);
  });

  test("questions come one at a time and the answers are saved", async () => {
    const replies = await onboard("full", ANSWERS);

    QUESTIONS.forEach((question, index) => expect(replies[index]).toMatch(question));
    expect(replies[4]).toBe("ok");
    // The last turn finishes onboarding, so the agent gets its tools back.
    expect(modelCalls.map((call) => call.toolChoice?.type)).toEqual(["tool", "auto"]);

    const resource = await resourceOf("full");
    expect(resource?.metadata?.onboarding).toBe("done");
    expect(resource?.workingMemory).toContain("Nickname: Andi");
    expect(resource?.workingMemory).toContain("Occupation: Developer");
    expect(resource?.workingMemory).toContain("Main goal: Membuat AI agent");
    expect(resource?.workingMemory).toContain("Language and answer style: Bahasa Indonesia, singkat");
    expect(resource?.workingMemory).not.toContain("halo");
  });

  test("answers sent the way Studio sends them move onboarding forward", async () => {
    const replies: string[] = [];
    for (const text of ["halo", ...ANSWERS]) {
      replies.push(await signal("studio", "studio-t1", "user", text));
    }

    QUESTIONS.forEach((question, index) => expect(replies[index]).toMatch(question));
    const resource = await resourceOf("studio");
    expect(resource?.metadata?.onboarding).toBe("done");
    expect(resource?.workingMemory).toContain("Nickname: Andi");
  });

  test("a known user is not asked again and the agent sees the profile in a new thread", async () => {
    await onboard("known", ANSWERS);

    const reply = await send("known", "known-t2", "halo lagi");

    expect(forcedTool()).toBeUndefined();
    expect(reply).toBe("ok");
    expect(modelCalls[0]!.system).toContain("Nickname: Andi");
  });

  test("each user is asked separately", async () => {
    await onboard("first", ANSWERS);

    const reply = await send("second", "second-t1", "halo");

    expect(reply).toMatch(QUESTIONS[0]!);
    expect(modelCalls[0]!.system).not.toContain("Nickname: Andi");
  });

  test("a half-finished onboarding continues in a new thread", async () => {
    await onboard("moved", ["Andi"]);

    const reply = await send("moved", "moved-t2", "Developer");

    expect(reply).toMatch(QUESTIONS[2]!);
  });

  test("a skipped question is left out of the profile", async () => {
    await onboard("partial", ["Andi", "lewati", "Membuat AI agent", "skip"]);

    const resource = await resourceOf("partial");
    expect(resource?.metadata?.onboarding).toBe("done");
    expect(resource?.workingMemory).toContain("Nickname: Andi");
    expect(resource?.workingMemory).not.toContain("Occupation:");
    expect(resource?.workingMemory).not.toContain("lewati");
    expect(resource?.workingMemory).not.toContain("Language and answer style:");
  });

  test("declining onboarding ends the questions for good", async () => {
    const replies = await onboard("decliner", ["Andi", "nanti saja"]);
    await send("decliner", "decliner-t2", "halo lagi");

    expect(replies[2]).toBe("ok");
    expect(forcedTool()).toBeUndefined();
    const resource = await resourceOf("decliner");
    expect(resource?.metadata?.onboarding).toBe("skipped");
    expect(resource?.workingMemory).toContain("Nickname: Andi");
    expect(resource?.workingMemory).not.toContain("nanti saja");
  });

  test("memory the user already had is kept", async () => {
    await memoryStore.updateResource({
      resourceId: "returning",
      workingMemory: "- Active schedules: sched-123",
    });

    await onboard("returning", ANSWERS);

    const resource = await resourceOf("returning");
    expect(resource?.workingMemory).toContain("sched-123");
    expect(resource?.workingMemory).toContain("Nickname: Andi");
  });

  test("a scheduled run is never turned into onboarding", async () => {
    await signal("scheduled", "scheduled-t1", "notification", "Brief me");

    expect(modelCalls.length).toBeGreaterThan(0);
    expect(forcedTool()).toBeUndefined();
  });
});
