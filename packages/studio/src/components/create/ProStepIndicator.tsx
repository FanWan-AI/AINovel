import { Check } from "lucide-react";

export interface StepMeta {
  index: number;
  label: string;
}

interface Props {
  steps: StepMeta[];
  currentStep: number; // 0-based
}

/**
 * Horizontal step-progress bar used by the Professional-mode create flow.
 * Fully responsive: collapses to icon-only on narrow viewports.
 */
export function ProStepIndicator({ steps, currentStep }: Props) {
  return (
    <nav aria-label="Progress" className="w-full">
      <ol className="flex items-center w-full">
        {steps.map((step, idx) => {
          const done = idx < currentStep;
          const active = idx === currentStep;

          return (
            <li key={step.index} className={`flex items-center ${idx < steps.length - 1 ? "flex-1" : ""}`}>
              {/* Circle */}
              <div className="flex flex-col items-center">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold shrink-0 transition-colors
                    ${done ? "bg-primary text-primary-foreground" : ""}
                    ${active ? "bg-primary text-primary-foreground ring-4 ring-primary/20" : ""}
                    ${!done && !active ? "bg-muted text-muted-foreground" : ""}
                  `}
                >
                  {done ? <Check size={14} strokeWidth={3} /> : idx + 1}
                </div>
                {/* Label — hidden on xs, shown sm+ */}
                <span
                  className={`mt-1 hidden sm:block text-[11px] leading-tight text-center font-medium transition-colors
                    ${active ? "text-primary" : done ? "text-foreground/70" : "text-muted-foreground"}
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
