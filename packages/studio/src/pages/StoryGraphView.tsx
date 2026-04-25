import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge as FlowEdge,
  type Node as FlowNode,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useApi } from "../hooks/use-api";
import type {
  StoryGraph,
  StoryGraphEdge,
  StoryGraphLayerSummary,
  StoryGraphNode,
  StoryGraphNodeType,
} from "../api/services/story-graph-service";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  CircleDot,
  FileText,
  GitBranch,
  Layers3,
  LocateFixed,
  Network,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Waypoints,
} from "lucide-react";

interface BookSummary {
  readonly id: string;
  readonly title: string;
  readonly genre: string;
  readonly status: string;
  readonly chaptersWritten: number;
}

interface Nav {
  readonly toBook: (id: string) => void;
  readonly toTruth: (id: string) => void;
}

interface PositionedNode extends StoryGraphNode {
  readonly x: number;
  readonly y: number;
}

interface DisplayGraph {
  readonly nodes: PositionedNode[];
  readonly edges: StoryGraphEdge[];
  readonly hiddenCounts: Partial<Record<StoryGraphNodeType, number>>;
}

interface GraphChangeProposal {
  readonly id: string;
  readonly nodeLabel: string;
  readonly nodeType: StoryGraphNodeType;
  readonly action: string;
  readonly impact: string;
  readonly createdAt: string;
}

const NODE_STYLE: Record<StoryGraphNodeType, {
  readonly label: string;
  readonly className: string;
  readonly accent: string;
  readonly icon: ReactNode;
}> = {
  book: {
    label: "作品核心",
    className: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-200",
    accent: "#e11d48",
    icon: <BookOpen size={15} />,
  },
  character: {
    label: "人物关系",
    className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200",
    accent: "#0284c7",
    icon: <CircleDot size={15} />,
  },
  chapter: {
    label: "剧情时间线",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200",
    accent: "#059669",
    icon: <FileText size={15} />,
  },
  hook: {
    label: "伏笔网络",
    className: "border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-200",
    accent: "#d97706",
    icon: <GitBranch size={15} />,
  },
  rule: {
    label: "设定规则",
    className: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-200",
    accent: "#7c3aed",
    icon: <ShieldCheck size={15} />,
  },
  state: {
    label: "当前状态",
    className: "border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-200",
    accent: "#0d9488",
    icon: <LocateFixed size={15} />,
  },
  theme: {
    label: "主题信号",
    className: "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-200",
    accent: "#c026d3",
    icon: <Sparkles size={15} />,
  },
};

const WIDTH = 1120;
const HEIGHT = 980;
const NODE_WIDTH = 172;
const NODE_HEIGHT = 82;
const INITIAL_VIEWPORT = { x: 64, y: 32, zoom: 0.66 };
const AGGREGATED_TYPES = new Set<StoryGraphNodeType>(["rule", "theme"]);

export function StoryGraphView({ nav }: { readonly nav: Nav }) {
  const { data: booksData, loading: booksLoading } = useApi<{ books: ReadonlyArray<BookSummary> }>("/books");
  const books = booksData?.books ?? [];
  const [selectedBookId, setSelectedBookId] = useState<string>("");
  const activeBookId = selectedBookId || books[0]?.id || "";
  const graphPath = activeBookId ? `/books/${activeBookId}/story-graph` : "";
  const { data, loading, error, refetch } = useApi<{ graph: StoryGraph }>(graphPath);
  const graph = data?.graph ?? null;
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [enabledLayers, setEnabledLayers] = useState<ReadonlySet<StoryGraphNodeType>>(
    () => new Set(["book", "state", "character", "chapter", "hook"]),
  );
  const [query, setQuery] = useState("");
  const [proposals, setProposals] = useState<ReadonlyArray<GraphChangeProposal>>([]);

  const visibleGraph = useMemo<DisplayGraph>(() => {
    if (!graph) return { nodes: [], edges: [], hiddenCounts: {} };
    const q = query.trim().toLowerCase();
    const filtered = graph.nodes.filter((node) => {
      if (!enabledLayers.has(node.type)) return false;
      if (!q) return true;
      return `${node.label} ${node.subtitle ?? ""} ${node.description ?? ""}`.toLowerCase().includes(q);
    });
    return buildDisplayGraph(filtered, graph.edges, {
      aggregateDenseSignals: !q && enabledLayers.size > 4,
      bookId: graph.bookId,
    });
  }, [enabledLayers, graph, query]);

  const selectedNode = useMemo(() => {
    if (!graph) return null;
    const fallback = visibleGraph.nodes.find((node) => node.type !== "book") ?? visibleGraph.nodes[0] ?? null;
    return visibleGraph.nodes.find((node) => node.id === selectedNodeId) ??
      graph.nodes.find((node) => node.id === selectedNodeId) ??
      fallback;
  }, [graph, selectedNodeId, visibleGraph.nodes]);

  const activeBook = books.find((book) => book.id === activeBookId);

  const addProposal = (node: StoryGraphNode, action: string) => {
    const proposal: GraphChangeProposal = {
      id: `${node.id}:${action}:${Date.now()}`,
      nodeLabel: node.label,
      nodeType: node.type,
      action,
      impact: buildImpactText(node),
      createdAt: new Date().toLocaleTimeString(),
    };
    setProposals((current) => [proposal, ...current].slice(0, 8));
  };

  return (
    <div className="flex h-full min-h-[calc(100vh-5rem)] bg-background">
      <aside className="hidden w-[286px] shrink-0 border-r border-border/60 bg-card/45 p-5 lg:block">
        <div className="mb-5">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <Layers3 size={14} />
            图层
          </div>
          <select
            value={activeBookId}
            onChange={(event) => {
              setSelectedBookId(event.target.value);
              setSelectedNodeId(null);
            }}
            className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
            disabled={booksLoading || books.length === 0}
          >
            {books.map((book) => (
              <option key={book.id} value={book.id}>{book.title}</option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          {(graph?.layers ?? []).map((layer) => (
            <LayerToggle
              key={layer.key}
              layer={layer}
              active={enabledLayers.has(layer.key)}
              onToggle={() => {
                setEnabledLayers((current) => {
                  const next = new Set(current);
                  if (next.has(layer.key)) next.delete(layer.key);
                  else next.add(layer.key);
                  return next;
                });
              }}
            />
          ))}
        </div>

        <div className="mt-7 space-y-3 rounded-lg border border-border/70 bg-background/55 p-4">
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">旧工具重组</div>
          {["市场雷达 -> 市场信号层", "文风分析 -> 文风 DNA 层", "导入工具 -> 素材入口", "真相文件 -> 证据层", "运行中心 -> 执行队列"].map((item) => (
            <div key={item} className="text-xs leading-5 text-muted-foreground">{item}</div>
          ))}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b border-border/60 px-6 py-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              <Network size={14} />
              故事地图
            </div>
            <h1 className="mt-1 text-3xl">创作驾驶舱</h1>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索人物、章节、伏笔"
                className="h-10 w-[260px] rounded-lg border border-border bg-card/70 pl-9 pr-3 text-sm outline-none focus:border-primary"
              />
            </div>
            <button
              onClick={() => refetch()}
              className="flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <RefreshCw size={15} />
              重建
            </button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_390px]">
          <div className="min-h-0 overflow-auto p-5">
            {loading || booksLoading ? (
              <div className="flex h-full min-h-[560px] items-center justify-center text-sm text-muted-foreground">正在构建叙事图谱...</div>
            ) : error ? (
              <div className="flex h-full min-h-[560px] items-center justify-center text-sm text-destructive">{error}</div>
            ) : !graph ? (
              <div className="flex h-full min-h-[560px] items-center justify-center text-sm text-muted-foreground">选择一本书开始生成故事地图。</div>
            ) : (
              <StoryCanvas
                nodes={visibleGraph.nodes}
                edges={visibleGraph.edges}
                hiddenCounts={visibleGraph.hiddenCounts}
                selectedNodeId={selectedNodeId}
                onSelectNode={setSelectedNodeId}
              />
            )}
            <ChangeQueuePanel
              proposals={proposals}
              onClear={() => setProposals([])}
            />
          </div>

          <aside className="min-h-0 border-l border-border/60 bg-card/35">
            <NodeDetailPanel
              bookTitle={activeBook?.title ?? graph?.title ?? "未选择作品"}
              graph={graph}
              node={selectedNode}
              onCreateProposal={addProposal}
              onOpenBook={() => activeBookId && nav.toBook(activeBookId)}
              onOpenTruth={() => activeBookId && nav.toTruth(activeBookId)}
            />
          </aside>
        </div>
      </section>
    </div>
  );
}

function LayerToggle({
  layer,
  active,
  onToggle,
}: {
  readonly layer: StoryGraphLayerSummary;
  readonly active: boolean;
  readonly onToggle: () => void;
}) {
  const style = NODE_STYLE[layer.key];
  return (
    <button
      onClick={onToggle}
      className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left transition-colors ${
        active ? style.className : "border-border/60 bg-background/45 text-muted-foreground"
      }`}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        {style.icon}
        {style.label}
      </span>
      <span className="rounded-md bg-background/65 px-2 py-0.5 text-xs tabular-nums">{layer.count}</span>
    </button>
  );
}

function StoryCanvas({
  nodes,
  edges,
  hiddenCounts,
  selectedNodeId,
  onSelectNode,
}: {
  readonly nodes: ReadonlyArray<PositionedNode>;
  readonly edges: ReadonlyArray<StoryGraphEdge>;
  readonly hiddenCounts: Partial<Record<StoryGraphNodeType, number>>;
  readonly selectedNodeId: string | null;
  readonly onSelectNode: (nodeId: string) => void;
}) {
  const [viewport, setViewport] = useState(INITIAL_VIEWPORT);
  const graphSignature = `${nodes.map((node) => node.id).join("|")}:${edges.length}`;

  useEffect(() => {
    setViewport(INITIAL_VIEWPORT);
  }, [graphSignature]);

  const selectedRelatedNodeIds = useMemo(() => {
    if (!selectedNodeId) return new Set<string>();
    return new Set(edges.flatMap((edge) => {
      if (edge.source === selectedNodeId) return [edge.target];
      if (edge.target === selectedNodeId) return [edge.source];
      return [];
    }));
  }, [edges, selectedNodeId]);

  const flowNodes = useMemo<FlowNode[]>(() => nodes.map((node) => {
    const style = NODE_STYLE[node.type];
    const isSelected = selectedNodeId === node.id;
    const isRelated = selectedRelatedNodeIds.has(node.id);
    const isDimmed = Boolean(selectedNodeId) && !isSelected && !isRelated;
    return {
      id: node.id,
      type: "default",
      position: { x: node.x, y: node.y },
      selected: isSelected,
      data: {
        label: (
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] opacity-70">
              {style.icon}
              {style.label}
            </div>
            <div className="line-clamp-2 text-sm font-semibold leading-4">{node.label}</div>
            <div className="mt-1 truncate text-[11px] opacity-70">{node.subtitle ?? node.status ?? "证据可追踪"}</div>
          </div>
        ),
      },
      style: {
        width: NODE_WIDTH,
        minHeight: NODE_HEIGHT,
        borderRadius: 8,
        border: `1px solid color-mix(in oklch, ${style.accent} 34%, var(--border))`,
        background: `linear-gradient(180deg, color-mix(in oklch, ${style.accent} 14%, var(--card)) 0%, var(--card) 115%)`,
        color: "var(--foreground)",
        boxShadow: isSelected
          ? `0 0 0 2px ${style.accent}, 0 18px 42px -24px ${style.accent}`
          : "0 14px 34px -28px rgb(0 0 0 / 0.45)",
        opacity: isDimmed ? 0.34 : 1,
        transition: "opacity 180ms ease, box-shadow 180ms ease, transform 180ms ease",
      },
    };
  }), [nodes, selectedNodeId, selectedRelatedNodeIds]);

  const flowEdges = useMemo<FlowEdge[]>(() => edges.map((edge) => {
    const source = nodes.find((node) => node.id === edge.source);
    const sourceColor = source ? NODE_STYLE[source.type].accent : "var(--primary)";
    const isSelectedEdge = selectedNodeId === edge.source || selectedNodeId === edge.target;
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: isSelectedEdge ? edge.label : undefined,
      animated: edge.strength > 0.62 || isSelectedEdge,
      style: {
        stroke: sourceColor,
        strokeOpacity: isSelectedEdge ? 0.82 : 0.16 + edge.strength * 0.16,
        strokeWidth: isSelectedEdge ? 2.6 : 1.2,
      },
      labelStyle: { fill: "var(--foreground)", fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: "var(--card)", fillOpacity: 0.88 },
      labelBgPadding: [6, 3] as [number, number],
    };
  }), [edges, nodes, selectedNodeId]);

  return (
    <div
      className="story-graph-shell relative h-[900px] min-h-[900px] overflow-hidden rounded-lg border border-border/70 bg-[radial-gradient(circle_at_50%_20%,color-mix(in_oklch,var(--primary)_10%,transparent),transparent_34%),linear-gradient(color-mix(in_oklch,var(--border)_28%,transparent)_1px,transparent_1px),linear-gradient(90deg,color-mix(in_oklch,var(--border)_28%,transparent)_1px,transparent_1px)] bg-[size:100%_100%,32px_32px,32px_32px] shadow-soft"
      data-testid="story-graph-canvas"
    >
      <ReactFlow
        key={graphSignature}
        nodes={flowNodes}
        edges={flowEdges}
        viewport={viewport}
        onViewportChange={setViewport}
        minZoom={0.42}
        maxZoom={1.35}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        onNodeClick={(_, node) => onSelectNode(node.id)}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={32} color="color-mix(in oklch, var(--border) 56%, transparent)" />
        <Controls className="!border-border !bg-card !text-foreground" />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => {
            const source = nodes.find((item) => item.id === node.id);
            return source ? NODE_STYLE[source.type].accent : "var(--primary)";
          }}
          className="!border-border !bg-card/90"
        />
      </ReactFlow>
      <div className="pointer-events-none absolute left-5 top-4 grid grid-cols-4 gap-2 text-[11px] font-semibold text-muted-foreground">
        {["人物", "章节网格", "伏笔债务", "辅助信号"].map((label) => (
          <span key={label} className="rounded-md border border-border/60 bg-card/70 px-2 py-1 backdrop-blur">{label}</span>
        ))}
      </div>
      {(hiddenCounts.rule || hiddenCounts.theme) ? (
        <div className="pointer-events-none absolute right-5 top-4 rounded-lg border border-border/60 bg-card/80 px-3 py-2 text-xs leading-5 text-muted-foreground backdrop-blur">
          总览已聚合 {hiddenCounts.rule ?? 0} 条规则、{hiddenCounts.theme ?? 0} 个主题信号
        </div>
      ) : null}
      <div className="absolute bottom-4 left-4 flex items-center gap-2 rounded-lg border border-border/70 bg-card/85 px-3 py-2 text-xs text-muted-foreground backdrop-blur">
        <Waypoints size={14} />
        {nodes.length} 个节点 · {edges.length} 条关系
      </div>
    </div>
  );
}

function NodeDetailPanel({
  bookTitle,
  graph,
  node,
  onCreateProposal,
  onOpenBook,
  onOpenTruth,
}: {
  readonly bookTitle: string;
  readonly graph: StoryGraph | null;
  readonly node: StoryGraphNode | null;
  readonly onCreateProposal: (node: StoryGraphNode, action: string) => void;
  readonly onOpenBook: () => void;
  readonly onOpenTruth: () => void;
}) {
  if (!graph || !node) {
    return <div className="p-6 text-sm text-muted-foreground">点击节点查看证据、风险和可执行动作。</div>;
  }

  const style = NODE_STYLE[node.type];
  const relatedEdges = graph.edges.filter((edge) => edge.source === node.id || edge.target === node.id).slice(0, 8);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border/60 p-5">
        <div className={`mb-3 inline-flex items-center gap-2 rounded-lg border px-2.5 py-1 text-xs font-semibold ${style.className}`}>
          {style.icon}
          {style.label}
        </div>
        <h2 className="text-2xl">{node.label}</h2>
        <div className="mt-2 max-h-52 overflow-y-auto rounded-lg border border-border/55 bg-background/45 p-3">
          <StructuredEvidence
            content={node.description || node.subtitle || bookTitle}
            source={node.evidence[0]?.source ?? node.type}
            nodeType={node.type}
            compact
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <section className="mb-6">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <CheckCircle2 size={14} />
            证据
          </div>
          <div className="space-y-3">
            {node.evidence.length > 0 ? node.evidence.map((item, index) => (
              <div key={`${item.source}-${index}`} className="rounded-lg border border-border/70 bg-background/55 p-3">
                <div className="mb-1 font-mono text-[11px] text-primary">{item.source}</div>
                <StructuredEvidence content={item.excerpt} source={item.source} nodeType={node.type} />
              </div>
            )) : (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-200">
                这个节点还缺少可点击来源，后续抽取需要补证据。
              </div>
            )}
          </div>
        </section>

        <section className="mb-6">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <GitBranch size={14} />
            关系
          </div>
          <div className="space-y-2">
            {relatedEdges.length > 0 ? relatedEdges.map((edge) => (
              <div key={edge.id} className="flex items-center justify-between rounded-lg border border-border/60 bg-background/45 px-3 py-2 text-sm">
                <span>{edge.label}</span>
                <span className="font-mono text-xs text-muted-foreground">{Math.round(edge.strength * 100)}%</span>
              </div>
            )) : (
              <div className="text-sm text-muted-foreground">暂无关系边。</div>
            )}
          </div>
        </section>

        <section className="mb-6 rounded-lg border border-border/70 bg-background/55 p-4">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <AlertTriangle size={14} />
            影响分析
          </div>
          <div className="space-y-2 text-sm leading-6 text-muted-foreground">
            <p>{buildImpactText(node)}</p>
            <p>编辑不会直接覆盖正文，会先进入变更队列并生成 diff。</p>
          </div>
        </section>

        <section>
          <div className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">变更队列</div>
          <div className="space-y-2">
            {buildProposalActions(node).map((action) => (
              <button
                key={action}
                onClick={() => onCreateProposal(node, action)}
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-left text-sm transition-colors hover:border-primary/50 hover:text-primary"
              >
                {action}
              </button>
            ))}
          </div>
        </section>
      </div>

      <div className="flex gap-2 border-t border-border/60 p-4">
        <button onClick={onOpenBook} className="flex-1 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground">
          打开作品
        </button>
        <button onClick={onOpenTruth} className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm">
          证据层
        </button>
      </div>
    </div>
  );
}

function ChangeQueuePanel({
  proposals,
  onClear,
}: {
  readonly proposals: ReadonlyArray<GraphChangeProposal>;
  readonly onClear: () => void;
}) {
  return (
    <section className="mt-4 rounded-lg border border-border/70 bg-card/55 shadow-soft">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">变更队列</div>
          <div className="mt-1 text-sm text-muted-foreground">编辑图谱先生成影响分析，确认后才进入正文或真相文件修订。</div>
        </div>
        <button
          onClick={onClear}
          disabled={proposals.length === 0}
          className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-45"
        >
          清空
        </button>
      </div>
      <div className="grid gap-3 p-4 md:grid-cols-2">
        {proposals.length > 0 ? proposals.map((proposal) => {
          const style = NODE_STYLE[proposal.nodeType];
          return (
            <article key={proposal.id} className="rounded-lg border border-border/70 bg-background/65 p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${style.className}`}>
                  {style.icon}
                  {proposal.nodeLabel}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">{proposal.createdAt}</span>
              </div>
              <div className="text-sm font-semibold">{proposal.action}</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{proposal.impact}</p>
            </article>
          );
        }) : (
          <div className="md:col-span-2 rounded-lg border border-dashed border-border/70 bg-background/45 px-4 py-6 text-center text-sm text-muted-foreground">
            从右侧节点详情选择一个动作，系统会先把它放进待确认队列。
          </div>
        )}
      </div>
    </section>
  );
}

function buildDisplayGraph(
  nodes: ReadonlyArray<StoryGraphNode>,
  edges: ReadonlyArray<StoryGraphEdge>,
  options: {
    readonly aggregateDenseSignals: boolean;
    readonly bookId: string;
  },
): DisplayGraph {
  const hiddenCounts: Partial<Record<StoryGraphNodeType, number>> = {};
  let displayNodes = [...nodes];
  let displayEdges = [...edges];

  if (options.aggregateDenseSignals) {
    const bookNode = displayNodes.find((node) => node.type === "book");
    for (const type of AGGREGATED_TYPES) {
      const typed = displayNodes.filter((node) => node.type === type);
      if (typed.length <= 4 || !bookNode) continue;
      const keep = typed.slice(0, 3);
      const hidden = typed.slice(3);
      hiddenCounts[type] = hidden.length;
      const styleLabel = NODE_STYLE[type].label;
      const aggregateId = `aggregate:${type}:${options.bookId}`;
      const aggregateNode: StoryGraphNode = {
        id: aggregateId,
        type,
        label: type === "rule" ? "规则审计池" : "主题信号池",
        subtitle: `${typed.length} 项 · 点击左侧单独开启可展开`,
        description: `${styleLabel}在总览中自动聚合，避免规则/主题节点淹没人物、章节和伏笔主干。`,
        weight: 6,
        evidence: [{
          source: "story_graph.json",
          excerpt: keep.concat(hidden).map((node) => `- ${node.label}`).join("\n"),
        }],
      };
      displayNodes = displayNodes.filter((node) => node.type !== type).concat(keep, aggregateNode);
      const visibleIds = new Set(displayNodes.map((node) => node.id));
      displayEdges = displayEdges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
      displayEdges.push({
        id: `${aggregateId}->${bookNode.id}`,
        source: aggregateId,
        target: bookNode.id,
        type: "relates",
        label: "聚合信号",
        strength: 0.52,
      });
    }
  }

  const ids = new Set(displayNodes.map((node) => node.id));
  return {
    nodes: layoutNodes(displayNodes),
    edges: displayEdges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
    hiddenCounts,
  };
}

function layoutNodes(nodes: ReadonlyArray<StoryGraphNode>): PositionedNode[] {
  const groups: StoryGraphNodeType[] = ["book", "state", "character", "chapter", "hook", "rule", "theme"];
  const laneBase: Record<StoryGraphNodeType, {
    readonly x: number;
    readonly y: number;
    readonly columns: number;
    readonly dx: number;
    readonly dy: number;
  }> = {
    book: { x: 474, y: 330, columns: 1, dx: 0, dy: 112 },
    state: { x: 474, y: 72, columns: 1, dx: 0, dy: 112 },
    character: { x: 48, y: 92, columns: 2, dx: 210, dy: 118 },
    hook: { x: 760, y: 118, columns: 2, dx: 214, dy: 118 },
    chapter: { x: 318, y: 520, columns: 3, dx: 218, dy: 120 },
    theme: { x: 48, y: 760, columns: 3, dx: 210, dy: 118 },
    rule: { x: 704, y: 760, columns: 2, dx: 214, dy: 118 },
  };
  const positioned: PositionedNode[] = [];

  for (const type of groups) {
    const typed = sortNodesForLayout(nodes.filter((node) => node.type === type), type);
    const lane = laneBase[type];
    typed.forEach((node, index) => {
      const col = index % lane.columns;
      const row = Math.floor(index / lane.columns);
      positioned.push({
        ...node,
        x: clamp(lane.x + col * lane.dx, 18, WIDTH - NODE_WIDTH - 18),
        y: clamp(lane.y + row * lane.dy, 18, HEIGHT - NODE_HEIGHT - 18),
      });
    });
  }

  return positioned;
}

function sortNodesForLayout(
  nodes: ReadonlyArray<StoryGraphNode>,
  type: StoryGraphNodeType,
): StoryGraphNode[] {
  if (type === "chapter") {
    return [...nodes].sort((left, right) =>
      extractChapterNumber(left) - extractChapterNumber(right) ||
      left.label.localeCompare(right.label, "zh-Hans"),
    );
  }
  return [...nodes].sort((left, right) =>
    right.weight - left.weight ||
    left.label.localeCompare(right.label, "zh-Hans"),
  );
}

function extractChapterNumber(node: StoryGraphNode): number {
  const text = `${node.id} ${node.label}`;
  const match = text.match(/(?:chapter:|第)\s*(\d+)/u) ?? text.match(/\b(\d+)\b/u);
  return match?.[1] ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function StructuredEvidence({
  content,
  source,
  nodeType,
  compact = false,
}: {
  readonly content: string;
  readonly source: string;
  readonly nodeType: StoryGraphNodeType | string;
  readonly compact?: boolean;
}) {
  if (looksLikeMarkdownTable(content)) {
    return (
      <div className={`story-evidence-markdown ${compact ? "story-evidence-markdown-compact" : ""}`}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {normalizeMarkdownEvidence(content)}
        </ReactMarkdown>
      </div>
    );
  }

  const pipeFields = parsePipeEvidence(content, source, nodeType);
  if (pipeFields.length > 0) {
    return <EvidenceFieldGrid fields={pipeFields} compact={compact} />;
  }

  const jsonFields = parseJsonishEvidence(content);
  if (jsonFields.length > 0) {
    return <EvidenceFieldGrid fields={jsonFields} compact={compact} />;
  }

  const semicolonFields = parseSemicolonEvidence(content);
  if (semicolonFields.length > 2) {
    return <EvidenceFieldGrid fields={semicolonFields} compact={compact} />;
  }

  return (
    <div className={`story-evidence-markdown ${compact ? "story-evidence-markdown-compact" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {normalizeMarkdownEvidence(content)}
      </ReactMarkdown>
    </div>
  );
}

function EvidenceFieldGrid({
  fields,
  compact,
}: {
  readonly fields: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly compact: boolean;
}) {
  return (
    <dl className={`story-evidence-fields ${compact ? "story-evidence-fields-compact" : ""}`}>
      {fields.map((field, index) => (
        <div key={`${field.label}-${index}`} className="story-evidence-field">
          <dt>{field.label}</dt>
          <dd>{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const CHARACTER_FIELD_LABELS = ["人物", "定位", "外在特征", "语言/行动", "性格", "叙事身份", "目标", "当前状态", "后续计划"];
const HOOK_FIELD_LABELS = ["编号", "伏笔", "状态", "种下章节", "推进计划", "回收方式", "风险"];

function parsePipeEvidence(
  content: string,
  source: string,
  nodeType: StoryGraphNodeType | string,
): Array<{ label: string; value: string }> {
  const normalized = content.replace(/\s*\|\s*/gu, " | ").trim();
  if (!normalized.includes(" | ")) return [];
  if (normalized.startsWith("|") && normalized.includes("| ---")) return [];
  const cells = normalized
    .split(/\s+\|\s+/u)
    .map((cell) => cell.replace(/^[-|]+|[-|]+$/gu, "").trim())
    .filter(Boolean);
  if (cells.length < 2) return [];

  const labels = source.includes("character_matrix") || nodeType === "character"
    ? CHARACTER_FIELD_LABELS
    : source.includes("pending_hooks") || nodeType === "hook"
      ? HOOK_FIELD_LABELS
      : cells.map((_, index) => `字段 ${index + 1}`);

  return cells.map((value, index) => ({
    label: labels[index] ?? `字段 ${index + 1}`,
    value,
  }));
}

export function parseJsonishEvidence(content: string): Array<{ label: string; value: string }> {
  const normalized = content
    .replace(/\\n/gu, "\n")
    .replace(/\\"/gu, '"')
    .replace(/[{}]/gu, " ")
    .trim();
  if (!normalized.includes(":") || !/"?[a-zA-Z][\w.-]*"?\s*:/u.test(normalized)) return [];
  const pairs = [...normalized.matchAll(/"?([A-Za-z][\w.-]*)"?\s*:\s*"([\s\S]*?)"\s*(?=,\s*"?[A-Za-z][\w.-]*"?\s*:|$)/gu)];
  if (pairs.length < 1) return [];
  return pairs.map((match) => ({
    label: translateEvidenceKey(match[1]),
    value: cleanEvidenceValue(match[2]),
  })).filter((field) => field.value.length > 0);
}

function parseSemicolonEvidence(content: string): Array<{ label: string; value: string }> {
  const parts = content
    .split(/[；;]/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 3) return [];
  return parts.map((value, index) => ({
    label: index === 0 ? "核心描述" : `要点 ${index}`,
    value,
  }));
}

function translateEvidenceKey(key: string): string {
  const labels: Record<string, string> = {
    coreDescription: "核心描述",
    authorIntent: "作者意图",
    title: "标题",
    coreGenres: "核心类型",
    premise: "故事前提",
    genre: "类型",
    positioning: "定位",
    worldSetting: "世界设定",
    protagonist: "主角",
    mainConflict: "主冲突",
    endingDirection: "结局方向",
    styleRules: "文风规则",
    forbiddenPatterns: "禁区",
    targetAudience: "目标读者",
    platformIntent: "平台意图",
    hook: "钩子",
    promise: "读者承诺",
    theme: "主题",
  };
  return labels[key] ?? key;
}

export function normalizeMarkdownEvidence(content: string): string {
  const restoredEscapedBreaks = content.replace(/\\n/gu, "\n");
  const reconstructed = reconstructCollapsedMarkdownTable(restoredEscapedBreaks);
  if (reconstructed) return reconstructed;

  const normalized = restoredEscapedBreaks
    .replace(/\s+\|\s+/gu, " | ")
    .replace(/^\s*\|\s*/u, "| ")
    .replace(/\s*\|\s*$/u, " |")
    .trim();
  if (normalized.startsWith("|") && /\|\s*:?-{2,}:?\s*\|/u.test(normalized)) {
    return normalized
      .replace(/\s*\|\s*\|\s*/gu, " |\n| ")
      .replace(/^\|\s*/u, "| ")
      .replace(/\s+$/u, "");
  }
  return normalized;
}

function looksLikeMarkdownTable(content: string): boolean {
  const restoredEscapedBreaks = content.replace(/\\n/gu, "\n");
  if (reconstructCollapsedMarkdownTable(restoredEscapedBreaks)) return true;
  const normalized = restoredEscapedBreaks.replace(/\s+\|\s+/gu, " | ").trim();
  return normalized.startsWith("|") && /\|\s*:?-{2,}:?\s*\|/u.test(normalized);
}

function reconstructCollapsedMarkdownTable(content: string): string | null {
  const compact = content.replace(/\s+/gu, " ").trim();
  if (!compact.startsWith("|")) return null;
  const cells = compact
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean);
  const separatorIndex = cells.findIndex((cell) => /^:?-{2,}:?$/u.test(cell));
  if (separatorIndex <= 0) return null;

  const columnCount = separatorIndex;
  const separators = cells.slice(separatorIndex, separatorIndex + columnCount);
  if (separators.length !== columnCount || !separators.every((cell) => /^:?-{2,}:?$/u.test(cell))) {
    return null;
  }

  const header = cells.slice(0, columnCount);
  const body = cells.slice(separatorIndex + columnCount);
  const rows: string[][] = [];
  for (let index = 0; index + columnCount <= body.length; index += columnCount) {
    rows.push(body.slice(index, index + columnCount));
  }
  if (rows.length === 0) return null;

  return [
    `| ${header.join(" | ")} |`,
    `| ${separators.join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function cleanEvidenceValue(value: string): string {
  return value
    .replace(/\\n/gu, "\n")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n\s*/gu, "\n")
    .replace(/^["',\s]+|["',\s]+$/gu, "")
    .trim();
}

function buildImpactText(node: StoryGraphNode): string {
  if (node.type === "character") return "人物关系变更将影响 character_matrix.md、current_state.md 和未来章节规划。";
  if (node.type === "chapter") return "已写章节变更需要生成章节重写任务，并同步章节摘要与当前状态。";
  if (node.type === "hook") return "伏笔变更将影响 pending_hooks.md、未来章节安排和回收节奏。";
  if (node.type === "rule") return "规则变更应扫描全书，标出违反规则的章节并生成修复队列。";
  if (node.type === "theme") return "主题信号变更会影响后续大纲、市场定位和文风取舍。";
  return "当前节点可作为后续规划、审计和重写任务的上下文锚点。";
}

function buildProposalActions(node: StoryGraphNode): string[] {
  if (node.type === "character") return ["把这个关系设为未来重点", "生成人物线影响分析"];
  if (node.type === "hook") return ["安排到下一章回收", "生成伏笔推进任务"];
  if (node.type === "chapter") return ["生成本章重写提案", "同步章节摘要"];
  if (node.type === "rule") return ["扫描违规章节", "生成规则修复队列"];
  return ["加入下一章规划上下文", "生成图谱变更提案"];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
