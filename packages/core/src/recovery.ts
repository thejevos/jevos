import type { Policy, Verdict } from "./policy.js";

export interface RecoveryInput {
  /** P(retrying the same action would succeed), from Jev */
  retryUseful?: number;
  /** Retries already spent on this exact action */
  retries: number;
  /** Replans already spent in this run */
  replans: number;
  error: string;
}

/**
 * Tool failure tree: retry if it looks transient and budget remains,
 * otherwise change strategy, otherwise hand over to a human.
 */
export function decideRecovery(input: RecoveryInput, policy: Policy): Verdict {
  if ((input.retryUseful ?? 0) >= 0.5 && input.retries < policy.maxRetries) {
    return { action: "RETRY", rule: "retry_transient", reason: `failure looks transient (p=${(input.retryUseful ?? 0).toFixed(2)}), retry ${input.retries + 1}/${policy.maxRetries}` };
  }
  if (input.replans < policy.maxReplans) {
    return {
      action: "REPLAN",
      rule: "recover_replan",
      reason: "retry unlikely to help or retries exhausted",
      hint: `The last action failed: ${input.error}. Try a different tool or different arguments.`,
    };
  }
  return { action: "HUMAN_REVIEW", rule: "recover_escalate", reason: "retries and replans exhausted" };
}
