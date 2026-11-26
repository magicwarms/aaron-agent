import { parseMemoryRequestContext } from "@mastra/core/memory";
import {
  BaseProcessor,
  type ProcessInputStepArgs,
} from "@mastra/core/processors";
import {
  ONBOARDING_KEY,
  ONBOARDING_REPLY,
} from "../workflows/onboarding-workflow";

// "workflow-" plus the key used in the agent's `workflows` option.
const ONBOARDING_TOOL = "workflow-onboardingWorkflow";

type Message = ProcessInputStepArgs["messages"][number];

// A person typing, not a scheduled run or another system notification.
const isFromUser = (message: Message) =>
  message.role === "user" ||
  (message.role === "signal" &&
    (message.content.metadata?.signal as { type?: string } | undefined)
      ?.type === "user");

const textOf = (message: Message) =>
  message.content.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ");

/**
 * Makes onboarding come first. Until a user is marked as onboarded, each of
 * their messages goes through the onboarding workflow, and the model may then
 * only reply with the next question.
 */
export class OnboardingGate extends BaseProcessor<"onboarding-gate"> {
  readonly id = "onboarding-gate";

  async processInputStep({
    stepNumber,
    messages,
    requestContext,
    state,
  }: ProcessInputStepArgs) {
    if (stepNumber === 0) {
      const latest = messages.at(-1);
      state.fromUser = Boolean(latest && isFromUser(latest));
      if (state.fromUser) requestContext?.set(ONBOARDING_REPLY, textOf(latest!));
    }
    if (!state.fromUser) return;

    const resourceId = parseMemoryRequestContext(requestContext)?.resourceId;
    const store = await this.mastra?.getStorage()?.getStore("memory");
    // Without a user or storage there is nothing to remember.
    if (!resourceId || !store) return;

    const resource = await store.getResourceById({ resourceId });
    if (resource?.metadata?.[ONBOARDING_KEY]) return;

    return {
      toolChoice:
        stepNumber === 0
          ? { type: "tool" as const, toolName: ONBOARDING_TOOL }
          : ("none" as const),
    };
  }
}
