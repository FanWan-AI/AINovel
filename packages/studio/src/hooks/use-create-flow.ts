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
