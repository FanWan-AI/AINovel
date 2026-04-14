import { Check, Lock } from "lucide-react";

export interface StepMeta {
  index: number;
  label: string;
}

interface Props {
  steps: StepMeta[];
  currentStep: number; // 0-based
  /**
   * The highest step index that the user has completed validation for.
   * Steps beyond `highestValidated + 1` are locked and not clickable.
   * Defaults to `-1` (no steps validated yet).
   */
  highestValidated?: number;
  /** Called when the user clicks a reachable step circle. */
  onStepClick?: (index: number) => void;
}

/**
 * Horizontal step-progress bar used by the Professional-mode create flow.
 * Fully responsive: collapses to icon-only on narrow viewports.
 * Supports click-to-jump navigation guarded by `highestValidated`.
 */
export function ProStepIndicator({ steps, currentStep, highestValidated = -1, onStepClick }: Props) {
  return (
    <nav aria-label="Progress" className="w-full">
      <ol className="flex items-center w-full">
        {steps.map((step, idx) => {
          const done = idx < currentStep;
          const active = idx === currentStep;
          const reachable = idx <= highestValidated + 1;
          const locked = !reachable;

          return (
            <li key={step.index} className={`flex items-center ${idx < steps.length - 1 ? "flex-1" : ""}`}>
              {/* Circle */}
              <div className="flex flex-col items-center">
                <div
                  role={onStepClick && reachable ? "button" : undefined}
                  aria-label={step.label}
                  aria-current={active ? "step" : undefined}
                  aria-disabled={locked ? true : undefined}
                  tabIndex={onStepClick && reachable ? 0 : undefined}
                  onClick={() => { if (onStepClick && reachable) onStepClick(idx); }}
                  onKeyDown={(e) => {
                    if ((e.key === "Enter" || e.key === " ") && onStepClick && reachable) {
                      e.preventDefault();
                      onStepClick(idx);
                    }
                  }}
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold shrink-0 transition-colors
                    ${done ? "bg-primary text-primary-foreground" : ""}
                    ${active ? "bg-primary text-primary-foreground ring-4 ring-primary/20" : ""}
                    ${!done && !active && !locked ? "bg-muted text-muted-foreground" : ""}
                    ${locked ? "bg-muted/50 text-muted-foreground/40 cursor-not-allowed" : ""}
                    ${onStepClick && reachable ? "cursor-pointer" : ""}
                  `}
                >
                  {locked ? <Lock size={12} strokeWidth={2.5} /> : done ? <Check size={14} strokeWidth={3} /> : idx + 1}
                </div>
                {/* Label — hidden on xs, shown sm+ */}
                <span
                  className={`mt-1 hidden sm:block text-[11px] leading-tight text-center font-medium transition-colors
                    ${active ? "text-primary" : done ? "text-foreground/70" : locked ? "text-muted-foreground/40" : "text-muted-foreground"}
                  `}
                >
                  {step.label}
                </span>
              </div>

              {/* Connector line */}
              {idx < steps.length - 1 && (
                <div className="flex-1 mx-2">
                  <div
                    className={`h-0.5 rounded-full transition-colors ${done ? "bg-primary" : "bg-border"}`}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
