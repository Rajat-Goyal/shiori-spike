import type { ConversationPhase } from "./repository.js";

export const conversationCopy = {
  decline: "Okay — I won’t turn it into a promise.",
  expired:
    "That draft expired after 24 hours of inactivity. Nothing was saved. Please send the promise again to start over.",
  failureNoDraft:
    "I couldn’t safely process that. Nothing was changed. Please try saying it another way.",
  failureWithDraft:
    "I couldn’t safely process that. Your current draft is unchanged. Please try saying it another way.",
  impliedPermission:
    "Would you like me to help turn that into a promise? Reply yes or no.",
  interrupted:
    "I no longer have the permission request. Nothing was saved. Please send the promise again to start over.",
  missingDefinition: "What will count as done?",
  missingTarget:
    "When should this be done? Please include a date and time in Singapore time.",
  overdueTarget:
    "That date and time has already passed. Your current draft is unchanged. Please send a future Singapore date and time.",
  targetFailureNoDraft:
    "I still need a future Singapore date and time. Nothing was saved. For example: 30 July 2026 at 9:00am Singapore time.",
  targetFailureWithDraft:
    "I still need a future Singapore date and time. Your current draft is unchanged. For example: 30 July 2026 at 9:00am Singapore time.",
  permissionCollision:
    "I’m still waiting for your answer about the current intention. I didn’t start another promise.\n\nPlease reply yes or no: would you like me to help turn that into a promise?",
  permissionUnclear:
    "Please reply yes or no: would you like me to help turn that into a promise?",
  // Recovery copy replaces the old fail-closed apology. A rejected turn changes
  // no state, so the honest and useful reply is to re-ask what is still pending
  // rather than dead-end the owner with "I couldn't safely process that".
  recoverComplete:
    "Your promise is ready and unchanged. Send /status to see it, or tell me what to change.",
  recoverNoDraft:
    "I didn’t catch that. Tell me what you’ll do and when, and I’ll set it up.",
  reset:
    "Reset is unavailable. Nothing was changed. Your confirmed promises and unconfirmed drafts are unchanged. Use /status to review them.",
} as const;

export function collectedDraftCopy(phase: ConversationPhase): string {
  switch (phase) {
    case "awaiting_definition":
      return conversationCopy.missingDefinition;
    case "awaiting_target":
      return conversationCopy.missingTarget;
    case "complete":
      return "I have the details. Nothing has been saved yet.";
  }
}

export function collisionCopy(phase: ConversationPhase): string {
  if (phase === "complete") {
    return "You already have a complete draft. I didn’t replace it.\n\nI have the details. Nothing has been saved yet.";
  }
  return `You already have a draft in progress. I didn’t replace it.\n\n${collectedDraftCopy(phase)}`;
}

export function correctionCopy(phase: ConversationPhase): string {
  return phase === "complete"
    ? "Updated. I have the details. Nothing has been saved yet."
    : `Updated.\n\n${collectedDraftCopy(phase)}`;
}

export function ordinaryWithDraftCopy(answer: string): string {
  return `${answer}\n\nYour current draft is unchanged.`;
}
