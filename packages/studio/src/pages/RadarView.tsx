import { useState, useEffect, useRef } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { fetchJson, ApiError } from "../hooks/use-api";
import { TrendingUp, Loader2, Target, ChevronDown, ChevronUp, Copy, Check } from "lucide-react";

interface Recommendation {
  readonly confidence: number;
  readonly platform: string;
  readonly genre: string;
  readonly concept: string;
  readonly reasoning: string;
  readonly benchmarkTitles: ReadonlyArray<string>;
}

interface RadarResult {
  readonly marketSummary: string;
  readonly recommendations: ReadonlyArray<Recommendation>;
}

interface Nav { toDashboard: () => void }

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export type RadarErrorType = "forbidden" | "rateLimit" | "serverError" | "unknown";

export function classifyRadarError(status: number | null): RadarErrorType {
  if (status === 403) return "forbidden";
  if (status === 429) return "rateLimit";
  if (status === 500) return "serverError";
  return "unknown";
}

export function buildDiagnosticCommand(): string {
  return "pnpm inkos doctor";
}

export async function copyDiagnosticCommand(
  deps?: { readonly clipboardImpl?: { writeText(text: string): Promise<void> } },
): Promise<void> {
  const clipboard = deps?.clipboardImpl ?? navigator.clipboard;
  await clipboard.writeText(buildDiagnosticCommand());
}

// ---------------------------------------------------------------------------
// Error banner sub-component
// ---------------------------------------------------------------------------

function errorTitleKey(type: RadarErrorType): Parameters<TFunction>[0] {
  if (type === "forbidden") return "radar.err.403.title";
  if (type === "rateLimit") return "radar.err.429.title";
  if (type === "serverError") return "radar.err.500.title";
  return "radar.err.unknown.title";
}

function errorHintKey(type: RadarErrorType): Parameters<TFunction>[0] {
  if (type === "forbidden") return "radar.err.403.hint";
  if (type === "rateLimit") return "radar.err.429.hint";
  if (type === "serverError") return "radar.err.500.hint";
  return "radar.err.unknown.hint";
}

interface ErrorBannerProps {
  readonly errorMessage: string;
  readonly errorType: RadarErrorType;
  readonly t: TFunction;
}

function ErrorBanner({ errorMessage, errorType, t }: ErrorBannerProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    try {
      await copyDiagnosticCommand();
      setCopied(true);
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — silently ignore
    }
  };

  return (
    <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-4 space-y-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 flex-1">
          <p className="font-semibold text-destructive">{t(errorTitleKey(errorType))}</p>
          <p className="text-muted-foreground leading-relaxed">{t(errorHintKey(errorType))}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => void handleCopy()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-background hover:bg-secondary transition-colors text-xs font-medium"
        >
          {copied ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
          {copied ? t("radar.err.copied") : t("radar.err.copy")}
        </button>

        <button
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-background hover:bg-secondary transition-colors text-xs font-medium text-muted-foreground"
        >
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          {expanded ? t("radar.err.detailsHide") : t("radar.err.details")}
        </button>
      </div>

      {expanded && (
        <pre className="mt-1 rounded-md bg-secondary px-3 py-2 text-[11px] font-mono text-muted-foreground whitespace-pre-wrap break-all">
          {errorMessage}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export function RadarView({ nav, theme, t }: { nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const [result, setResult] = useState<RadarResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [errorStatus, setErrorStatus] = useState<number | null>(null);

  const handleScan = async () => {
    setLoading(true);
    setError("");
    setErrorStatus(null);
    setResult(null);
    try {
      const data = await fetchJson<RadarResult>("/radar/scan", { method: "POST" });
      setResult(data);
    } catch (e) {
      if (e instanceof ApiError) {
        setErrorStatus(e.status);
      }
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.home")}</button>
        <span className="text-border">/</span>
        <span>{t("nav.radar")}</span>
      </div>

      <div className="flex items-center justify-between">
        <h1 className="font-serif text-3xl flex items-center gap-3">
          <TrendingUp size={28} className="text-primary" />
          {t("radar.title")}
        </h1>
        <button
          onClick={handleScan}
          disabled={loading}
          className={`px-5 py-2.5 text-sm rounded-lg ${c.btnPrimary} disabled:opacity-30 flex items-center gap-2`}
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Target size={14} />}
          {loading ? t("radar.scanning") : t("radar.scan")}
        </button>
      </div>

      {error && (
        <ErrorBanner
          errorMessage={error}
          errorType={classifyRadarError(errorStatus)}
          t={t}
        />
      )}

      {result && (
        <div className="space-y-6">
          <div className={`border ${c.cardStatic} rounded-lg p-5`}>
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">{t("radar.summary")}</h3>
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{result.marketSummary}</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {result.recommendations.map((rec, i) => (
              <div key={i} className={`border ${c.cardStatic} rounded-lg p-5 space-y-3`}>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    {rec.platform} · {rec.genre}
                  </span>
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                    rec.confidence >= 0.7 ? "bg-emerald-500/10 text-emerald-600" :
                    rec.confidence >= 0.4 ? "bg-amber-500/10 text-amber-600" :
                    "bg-muted text-muted-foreground"
                  }`}>
                    {(rec.confidence * 100).toFixed(0)}%
                  </span>
                </div>
                <p className="text-sm font-semibold">{rec.concept}</p>
                <p className="text-xs text-muted-foreground leading-relaxed">{rec.reasoning}</p>
                {rec.benchmarkTitles.length > 0 && (
                  <div className="flex gap-2 flex-wrap">
                    {rec.benchmarkTitles.map((bt) => (
                      <span key={bt} className="px-2 py-0.5 text-[10px] bg-secondary rounded">{bt}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {!result && !loading && !error && (
        <div className={`border border-dashed ${c.cardStatic} rounded-lg p-12 text-center text-muted-foreground text-sm italic`}>
          {t("radar.emptyHint")}
        </div>
      )}
    </div>
  );
}
