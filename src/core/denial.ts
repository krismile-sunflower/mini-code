/**
 * DenialTracker — mirrors Claude Code's denial tracking behaviour.
 *
 * When a user repeatedly denies the same tool/operation the AI tends to loop,
 * asking for the same permission again and again.  After maxConsecutive denials
 * for the same approval key we inject a correction message so the AI learns to
 * find an alternative approach.
 */

const MAX_CONSECUTIVE = 3;
const MAX_TOTAL = 20;

export class DenialTracker {
  private consecutive = new Map<string, number>();
  private total = 0;

  /** Record a denial for the given approval key. */
  record(key: string): void {
    this.consecutive.set(key, (this.consecutive.get(key) ?? 0) + 1);
    this.total += 1;
  }

  /** Reset the consecutive counter for a key (call when the operation succeeds). */
  reset(key: string): void {
    this.consecutive.delete(key);
  }

  /**
   * Returns true when the AI should receive a correction message.
   * Triggers if consecutive denials for this key hit MAX_CONSECUTIVE, or
   * if total denials across all keys hit MAX_TOTAL.
   */
  shouldInjectCorrection(key: string): boolean {
    return (this.consecutive.get(key) ?? 0) >= MAX_CONSECUTIVE || this.total >= MAX_TOTAL;
  }

  /** The correction message to inject into the conversation. */
  correctionMessage(key: string): string {
    const count = this.consecutive.get(key) ?? 0;
    if (this.total >= MAX_TOTAL) {
      return `Your last ${this.total} tool calls have been denied by the user. The user does not want you to proceed with these operations. Please stop and ask the user what they would like you to do instead.`;
    }
    return `Your tool call was denied ${count} time${count === 1 ? "" : "s"} in a row. The user does not want you to use this tool or approach. Please find a different way to accomplish the task, or ask the user for guidance.`;
  }
}
