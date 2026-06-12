import { connectStore } from "./store/client.js";
import { recoverInterruptedJobs } from "./store/job-records.js";

export {
  loadCodeVersion,
  saveCodeVersion,
  sha256,
} from "./store/code-versions.js";
export {
  createQueuedJobRecord,
  failJobRecord,
  finishJobRecord,
  markJobRunning,
  recoverInterruptedJobs,
} from "./store/job-records.js";

export async function initStore() {
  await connectStore();
  await recoverInterruptedJobs();
}
