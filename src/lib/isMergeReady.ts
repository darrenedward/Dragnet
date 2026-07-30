/** @deprecated Prefer `@/src/lib/mergeReady` — kept for import compatibility. */
export {
  isMergeReady,
  mergeReadyLabel,
  MERGE_RATING_THRESHOLD as MERGE_READY_RATING_THRESHOLD,
  type MergeReadyInput,
  type MergeReadyResult,
  type MergeBlockReason,
} from "./mergeReady";

import { isMergeReady as evaluateMergeReady } from "./mergeReady";
import type { MergeReadyInput } from "./mergeReady";

/** Boolean-only form for call sites that already surface a reason elsewhere. */
export function checkMergeReady(input: MergeReadyInput | null | undefined): boolean {
  return evaluateMergeReady(input).mergeReady;
}
