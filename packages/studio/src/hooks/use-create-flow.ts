import { useState } from "react";
import type { CreativeBrief } from "../shared/contracts";

export interface CreateFlowState {
  readonly briefId: string | null;
  readonly brief: CreativeBrief | null;
}

const INITIAL_STATE: CreateFlowState = {
  briefId: null,
  brief: null,
};

export function applyBriefUpdate(
  current: CreativeBrief | null,
  updates: Partial<CreativeBrief>,
): CreativeBrief | null {
  if (!current) return null;
  return { ...current, ...updates };
}

export function useCreateFlow() {
  const [state, setState] = useState<CreateFlowState>(INITIAL_STATE);

  const setBrief = (briefId: string, brief: CreativeBrief) => {
    setState({ briefId, brief });
  };

  const updateBrief = (updates: Partial<CreativeBrief>) => {
    setState((prev) => ({
      ...prev,
      brief: applyBriefUpdate(prev.brief, updates),
    }));
  };

  const reset = () => {
    setState(INITIAL_STATE);
  };

  return { ...state, setBrief, updateBrief, reset };
}

// ---------------------------------------------------------------------------
// Draft persistence helpers (Pro create flow)
// ---------------------------------------------------------------------------

/** localStorage key for the Pro-mode multi-step form draft. */
export const PRO_DRAFT_KEY = "inkos-pro-draft-v1";

/**
 * Loads a previously saved draft from storage.
 * Returns `null` if nothing is stored or parsing fails.
 */
export function loadDraft<T>(key: string, storage: Pick<Storage, "getItem"> = localStorage): T | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Persists `data` as a JSON string in storage under `key`.
 * Silently ignores quota or unavailability errors.
 */
export function saveDraft<T>(key: string, data: T, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(key, JSON.stringify(data));
  } catch {
    // Ignore storage quota / unavailability errors.
  }
}

/**
 * Removes a draft entry from storage.
 */
export function clearDraft(key: string, storage: Pick<Storage, "removeItem"> = localStorage): void {
  storage.removeItem(key);
}

// ---------------------------------------------------------------------------
// Step guard helpers
// ---------------------------------------------------------------------------

/**
 * Returns whether the user may navigate to `target` given the highest step
 * index for which they have already completed validation.
 *
 * Users may freely move back to any earlier step, move to the current step,
 * or advance exactly one step (which will be validated on entry).
 * Jumping ahead by two or more locked steps is not allowed.
 */
export function canNavigateToStep(target: number, highestValidated: number): boolean {
  return target <= highestValidated + 1;
}
