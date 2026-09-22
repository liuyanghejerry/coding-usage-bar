import { collectStatusSnapshot } from "./runtime.js";
import { markNotified, markRecovered, runCodexResetNotifications, sendNotification, shouldNotify } from "./notifier.js";

export async function runDaemonOnce(options: { dryRun?: boolean } = {}) {
  const snapshot = await collectStatusSnapshot();
  const messages: string[] = [];

  for (const { analysis } of snapshot.providers) {
    if (!shouldNotify(analysis)) {
      if (!options.dryRun) {
        markRecovered(analysis);
      }
      continue;
    }
    messages.push(sendNotification(analysis, options.dryRun));
    if (!options.dryRun) {
      markNotified(analysis);
    }
  }

  // Reset announcements are rare but time-sensitive; the transition checks
  // keep them to one notification per genuine upstream event.
  messages.push(...runCodexResetNotifications(snapshot.codexReset, options));

  return messages.length ? messages : ["No notification needed."];
}
