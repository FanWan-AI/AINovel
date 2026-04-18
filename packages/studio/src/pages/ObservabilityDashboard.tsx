import { useMemo, useState, type ReactNode } from "react";
import { Activity, BarChart3, Bot, Coins, Gauge, RefreshCw, Wrench } from "lucide-react";
import { useApi } from "../hooks/use-api";

interface Nav {
  readonly toDashboard: () => void;
}

interface AssistantMetricsPoint {
  readonly date: string;
  readonly firstSuccessRate: number;
  readonly autoFixSuccessRate: number;
  readonly manualInterventionRate: number;
  readonly averageChapterScore: number;
  readonly tokenConsumption: number;
  readonly activeTasks: number;
}

interface AssistantMetricsResponse {
  readonly series: ReadonlyArray<AssistantMetricsPoint>;
  readonly summary: {
    readonly firstSuccessRate: number;
    readonly autoFixSuccessRate: number;
    readonly manualInterventionRate: number;
    readonly averageChapterScore: number;
    readonly tokenConsumption: number;
    readonly activeTasks: number;
  };
  readonly meta: {
    readonly generatedAt: string;
    readonly rangeDays: 7 | 30;
    readonly truncated: boolean;
  };
}

const RANGE_OPTIONS = [7, 30] as const;

export function ObservabilityDashboard({ nav }: { nav: Nav }) {
  const [rangeDays, setRangeDays] = useState<(typeof RANGE_OPTIONS)[number]>(7);
  const { data, loading, error, refetch } = useApi<AssistantMetricsResponse>(`/assistant/metrics?range=${rangeDays}`);
  const points = data?.series ?? [];
  const updatedAt = useMemo(() => {
    if (!data?.meta.generatedAt) {
      return "—";
    }
    return new Date(data.meta.generatedAt).toLocaleString();
  }, [data?.meta.generatedAt]);

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card/50 p-6 shadow-sm lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
            <BarChart3 size={14} />
            Assistant Observability
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">任务质量趋势看板</h1>
            <p className="text-sm text-muted-foreground">
              聚合 Assistant task snapshots 与 chapter run ledger，观察成功率、修复率、人工介入与 token 消耗。
            </p>
          </div>
        </div>
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          <div className="inline-flex rounded-xl border border-border bg-background/70 p-1">
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setRangeDays(option)}
                className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                  rangeDays === option
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {option} 天
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void refetch()}
            className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <RefreshCw size={14} />
            刷新
          </button>
          <button
            type="button"
            onClick={nav.toDashboard}
            className="rounded-xl border border-border bg-background px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            返回总览
          </button>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <MetricCard title="首次成功率" value={`${data?.summary.firstSuccessRate ?? 0}%`} hint="首次执行即成功" icon={<Bot size={16} />} />
        <MetricCard title="自动修复成功率" value={`${data?.summary.autoFixSuccessRate ?? 0}%`} hint="修复型 run 应用成功" icon={<Wrench size={16} />} />
        <MetricCard title="人工介入率" value={`${data?.summary.manualInterventionRate ?? 0}%`} hint="需要人工确认/检查点" icon={<Activity size={16} />} />
        <MetricCard title="章节均分" value={`${data?.summary.averageChapterScore ?? 0}`} hint="按章节日均质量分" icon={<Gauge size={16} />} />
        <MetricCard title="Token 消耗" value={`${formatCompactNumber(data?.summary.tokenConsumption ?? 0)}`} hint="范围内累计 token" icon={<Coins size={16} />} />
        <MetricCard title="活跃任务" value={`${data?.summary.activeTasks ?? 0}`} hint="最新一天活跃任务数" icon={<BarChart3 size={16} />} />
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <TrendPanel
          title="成功与介入趋势"
          subtitle="成功率、自动修复率、人工介入率"
          points={points}
          lines={[
            { key: "firstSuccessRate", label: "首次成功率", color: "#2563eb", unit: "%" },
            { key: "autoFixSuccessRate", label: "自动修复成功率", color: "#16a34a", unit: "%" },
            { key: "manualInterventionRate", label: "人工介入率", color: "#ea580c", unit: "%" },
          ]}
        />
        <TrendPanel
          title="质量与成本趋势"
          subtitle="章节均分、token 消耗、活跃任务"
          points={points}
          lines={[
            { key: "averageChapterScore", label: "章节均分", color: "#7c3aed" },
            { key: "tokenConsumption", label: "Token 消耗", color: "#0891b2" },
            { key: "activeTasks", label: "活跃任务", color: "#dc2626" },
          ]}
        />
      </section>

      <section className="rounded-2xl border border-border/70 bg-card/40 p-5">
        {loading ? (
          <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">加载指标中…</div>
        ) : error ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <button
              type="button"
              onClick={() => void refetch()}
              className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
            >
              重试
            </button>
          </div>
        ) : points.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm font-medium">当前范围暂无可用指标</p>
            <p className="text-sm text-muted-foreground">缺失数据时会返回空序列；等待 Assistant 任务或章节运行后这里会自动呈现趋势。</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <span>时间范围：最近 {data?.meta.rangeDays ?? rangeDays} 天</span>
              <span>更新时间：{updatedAt}</span>
              {data?.meta.truncated && (
                <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-amber-600">
                  聚合已触发上限保护
                </span>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="px-3 py-2 font-medium">日期</th>
                    <th className="px-3 py-2 font-medium">首次成功率</th>
                    <th className="px-3 py-2 font-medium">自动修复成功率</th>
                    <th className="px-3 py-2 font-medium">人工介入率</th>
                    <th className="px-3 py-2 font-medium">章节均分</th>
                    <th className="px-3 py-2 font-medium">Token</th>
                    <th className="px-3 py-2 font-medium">活跃任务</th>
                  </tr>
                </thead>
                <tbody>
                  {points.map((point) => (
                    <tr key={point.date} className="border-b border-border/60">
                      <td className="px-3 py-2 font-medium">{point.date}</td>
                      <td className="px-3 py-2">{point.firstSuccessRate}%</td>
                      <td className="px-3 py-2">{point.autoFixSuccessRate}%</td>
                      <td className="px-3 py-2">{point.manualInterventionRate}%</td>
                      <td className="px-3 py-2">{point.averageChapterScore}</td>
                      <td className="px-3 py-2">{formatCompactNumber(point.tokenConsumption)}</td>
                      <td className="px-3 py-2">{point.activeTasks}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function MetricCard({
  title,
  value,
  hint,
  icon,
}: {
  title: string;
  value: string;
  hint: string;
  icon: ReactNode;
}) {
  return (
    <article className="rounded-2xl border border-border/70 bg-card/40 p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{title}</span>
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">{icon}</span>
      </div>
      <div className="text-2xl font-semibold tracking-tight">{value}</div>
      <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
    </article>
  );
}

function TrendPanel({
  title,
  subtitle,
  points,
  lines,
}: {
  title: string;
  subtitle: string;
  points: ReadonlyArray<AssistantMetricsPoint>;
  lines: ReadonlyArray<{ key: keyof AssistantMetricsPoint; label: string; color: string; unit?: string }>;
}) {
  return (
    <section className="rounded-2xl border border-border/70 bg-card/40 p-5 shadow-sm">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex flex-wrap justify-end gap-3 text-xs text-muted-foreground">
          {lines.map((line) => (
            <span key={line.label} className="inline-flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: line.color }} />
              {line.label}
            </span>
          ))}
        </div>
      </div>
      <TrendChart points={points} lines={lines} />
    </section>
  );
}

function TrendChart({
  points,
  lines,
}: {
  points: ReadonlyArray<AssistantMetricsPoint>;
  lines: ReadonlyArray<{ key: keyof AssistantMetricsPoint; label: string; color: string; unit?: string }>;
}) {
  if (points.length === 0) {
    return <div className="flex min-h-56 items-center justify-center text-sm text-muted-foreground">暂无趋势数据</div>;
  }

  const width = 640;
  const height = 240;
  const padding = 24;
  const values = points.flatMap((point) => lines.map((line) => Number(point[line.key]) || 0));
  const maxValue = Math.max(...values, 1);
  const stepX = points.length > 1 ? (width - padding * 2) / (points.length - 1) : 0;

  const toPoint = (lineKey: keyof AssistantMetricsPoint) =>
    points.map((point, index) => {
      const value = Number(point[lineKey]) || 0;
      const x = padding + stepX * index;
      const y = height - padding - ((height - padding * 2) * value) / maxValue;
      return `${x},${y}`;
    }).join(" ");

  return (
    <div className="space-y-3">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-60 w-full overflow-visible">
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = padding + (height - padding * 2) * ratio;
          return <line key={ratio} x1={padding} x2={width - padding} y1={y} y2={y} stroke="currentColor" strokeOpacity="0.12" />;
        })}
        {lines.map((line) => (
          <polyline
            key={line.label}
            fill="none"
            stroke={line.color}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={toPoint(line.key)}
          />
        ))}
        {points.map((point, index) => {
          const x = padding + stepX * index;
          return (
            <g key={point.date}>
              <line x1={x} x2={x} y1={height - padding} y2={height - padding + 6} stroke="currentColor" strokeOpacity="0.2" />
              <text x={x} y={height - 4} textAnchor="middle" fontSize="10" fill="currentColor" opacity="0.65">
                {point.date.slice(5)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="grid gap-2 sm:grid-cols-3">
        {lines.map((line) => {
          const latest = points[points.length - 1];
          const value = Number(latest?.[line.key]) || 0;
          return (
            <div key={line.label} className="rounded-xl border border-border/60 bg-background/50 px-3 py-2 text-sm">
              <div className="text-muted-foreground">{line.label}</div>
              <div className="mt-1 font-semibold" style={{ color: line.color }}>
                {formatCompactNumber(value)}
                {line.unit ?? ""}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return new Intl.NumberFormat("zh-CN", {
    notation: value >= 1000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1000 ? 1 : 1,
  }).format(value);
}
