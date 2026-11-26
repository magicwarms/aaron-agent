import type { Mastra } from "@mastra/core/mastra";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

// Resource metadata keys. They live outside working memory, so the model cannot
// overwrite them. ONBOARDING_KEY is "done" or "skipped" once finished.
export const ONBOARDING_KEY = "onboarding";
const PROGRESS_KEY = "onboardingProgress";

// The gate puts the user's message in the request context under this key, so the
// saved answer is what they typed, not what the model passes on.
export const ONBOARDING_REPLY = "onboardingReply";

// Add, remove, or reword questions here. The label is what gets saved.
const profileQuestions = [
  {
    label: "Nickname",
    question: "Sebelum mulai, aku mau kenal kamu dulu. Mau dipanggil apa?",
  },
  {
    label: "Occupation",
    question: "Apa pekerjaan atau kesibukan utamamu?",
  },
  {
    label: "Main goal",
    question: "Apa tujuan utama yang ingin kamu capai dengan bantuanku?",
  },
  {
    label: "Language and answer style",
    question: "Mau dijawab pakai bahasa apa, dan gaya seperti apa?",
  },
];

const SKIP_HINT = `Balas "lewati" untuk melewati pertanyaan ini, atau "nanti saja" untuk melewati semuanya.`;

const answersSchema = z.record(z.string(), z.string());
// The index of the question the user was last asked, and what they answered.
const progressSchema = z.object({
  index: z.number(),
  answers: answersSchema,
});

const memoryOf = async (mastra: Mastra, resourceId: string | undefined) => {
  const store = await mastra.getStorage()?.getStore("memory");
  if (!resourceId || !store) {
    throw new Error("Onboarding needs a resourceId and memory storage.");
  }
  return {
    resource: await store.getResourceById({ resourceId }),
    update: (changes: {
      workingMemory?: string;
      metadata: Record<string, unknown>;
    }) => store.updateResource({ resourceId, ...changes }),
  };
};

const recordAnswer = createStep({
  id: "record-answer",
  inputSchema: z.object({
    declined: z
      .boolean()
      .optional()
      .describe(
        "True only if the user says they do not want any of these questions now.",
      ),
  }),
  outputSchema: progressSchema.extend({ declined: z.boolean() }),
  execute: async ({ inputData, requestContext, resourceId, mastra }) => {
    const { resource } = await memoryOf(mastra, resourceId);
    const saved = progressSchema.safeParse(resource?.metadata?.[PROGRESS_KEY]);
    // Nothing has been asked yet, so this message is not an answer.
    if (!saved.success) return { index: 0, answers: {}, declined: false };

    const { index, answers } = saved.data;
    const reply = String(requestContext.get(ONBOARDING_REPLY) ?? "")
      .replace(/\s+/g, " ")
      .trim();

    if (inputData.declined || /^nanti saja$/i.test(reply)) {
      return { index, answers, declined: true };
    }
    // An empty message (for example only an attachment) asks the same again.
    if (!reply) return { index, answers, declined: false };

    const label = profileQuestions[index]?.label;
    if (label && !/^(skip|lewati)$/i.test(reply)) answers[label] = reply;
    return { index: index + 1, answers, declined: false };
  },
});

const saveProgress = createStep({
  id: "save-progress",
  inputSchema: recordAnswer.outputSchema,
  outputSchema: z.object({
    status: z.enum(["asking", "done", "skipped"]),
    question: z.string().optional(),
    profile: answersSchema,
  }),
  execute: async ({ inputData, resourceId, mastra }) => {
    const { index, answers, declined } = inputData;
    const { resource, update } = await memoryOf(mastra, resourceId);

    const next = profileQuestions[index];
    if (next && !declined) {
      await update({ metadata: { [PROGRESS_KEY]: { index, answers } } });
      return {
        status: "asking" as const,
        question: `${next.question}\n\n${SKIP_HINT}`,
        profile: answers,
      };
    }

    const status = declined ? ("skipped" as const) : ("done" as const);
    const lines = Object.entries(answers).map(
      ([label, answer]) => `- ${label}: ${answer}`,
    );
    const profile = lines.length ? ["# User Profile", ...lines].join("\n") : "";

    await update({
      // Append, so anything already remembered about the user is kept.
      workingMemory:
        [resource?.workingMemory, profile].filter(Boolean).join("\n\n") ||
        undefined,
      metadata: { [ONBOARDING_KEY]: status, [PROGRESS_KEY]: null },
    });

    return { status, profile: answers };
  },
});

// One run handles one chat message: record the answer, then return the next
// question or save the finished profile. It never suspends, because Studio does
// not deliver chat messages to a suspended run.
export const onboardingWorkflow = createWorkflow({
  id: "onboarding",
  description:
    "Collects a new user's profile one question per message and saves it to memory.",
  inputSchema: recordAnswer.inputSchema,
  outputSchema: saveProgress.outputSchema,
})
  .then(recordAnswer)
  .then(saveProgress)
  .commit();
