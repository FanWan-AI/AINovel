export type StoryGraphNodeType = "book" | "character" | "chapter" | "hook" | "rule" | "state" | "theme";
export type StoryGraphEdgeType = "contains" | "appears_in" | "advances" | "governs" | "focuses" | "relates";

export interface StoryGraphEvidence {
  readonly source: string;
  readonly excerpt: string;
}

export interface StoryGraphNode {
  readonly id: string;
  readonly type: StoryGraphNodeType;
  readonly label: string;
  readonly subtitle?: string;
  readonly description?: string;
  readonly status?: string;
  readonly weight: number;
  readonly evidence: ReadonlyArray<StoryGraphEvidence>;
}

export interface StoryGraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly type: StoryGraphEdgeType;
  readonly label: string;
  readonly strength: number;
}

export interface StoryGraphLayerSummary {
  readonly key: StoryGraphNodeType;
  readonly label: string;
  readonly count: number;
}

export interface StoryGraphStats {
  readonly characters: number;
  readonly chapters: number;
  readonly hooks: number;
  readonly rules: number;
  readonly unresolvedHooks: number;
  readonly evidenceFiles: number;
}

export interface StoryGraph {
  readonly schemaVersion: 1;
  readonly bookId: string;
  readonly title: string;
  readonly generatedAt: string;
  readonly stats: StoryGraphStats;
  readonly layers: ReadonlyArray<StoryGraphLayerSummary>;
  readonly nodes: ReadonlyArray<StoryGraphNode>;
  readonly edges: ReadonlyArray<StoryGraphEdge>;
}

export interface StoryGraphChapterInput {
  readonly number: number;
  readonly title: string;
  readonly status?: string;
  readonly wordCount?: number;
}

export interface BuildStoryGraphInput {
  readonly bookId: string;
  readonly title: string;
  readonly chapters: ReadonlyArray<StoryGraphChapterInput>;
  readonly truthFiles: Readonly<Record<string, string>>;
  readonly generatedAt?: string;
}

interface Candidate {
  readonly label: string;
  readonly subtitle?: string;
  readonly description?: string;
  readonly status?: string;
  readonly source: string;
  readonly excerpt: string;
  readonly weight?: number;
}

const MAX_CHARACTERS = 18;
const MAX_HOOKS = 18;
const MAX_RULES = 12;
const MAX_THEMES = 8;
const MAX_CHAPTERS = 60;

const TYPE_LABELS: Record<StoryGraphNodeType, string> = {
  book: "作品核心",
  character: "人物",
  chapter: "章节",
  hook: "伏笔",
  rule: "规则",
  state: "状态",
  theme: "主题",
};

export function buildStoryGraph(input: BuildStoryGraphInput): StoryGraph {
  const nodes = new Map<string, StoryGraphNode>();
  const edges = new Map<string, StoryGraphEdge>();

  const addNode = (node: StoryGraphNode) => {
    const existing = nodes.get(node.id);
    if (!existing) {
      nodes.set(node.id, node);
      return;
    }

    nodes.set(node.id, {
      ...existing,
      weight: Math.max(existing.weight, node.weight),
      evidence: mergeEvidence(existing.evidence, node.evidence),
      description: existing.description ?? node.description,
      subtitle: existing.subtitle ?? node.subtitle,
      status: existing.status ?? node.status,
    });
  };

  const addEdge = (edge: StoryGraphEdge) => {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) return;
    edges.set(edge.id, edge);
  };

  const bookNodeId = `book:${input.bookId}`;
  addNode({
    id: bookNodeId,
    type: "book",
    label: input.title,
    subtitle: "故事地图中心",
    description: compactText(input.truthFiles["author_intent.md"] ?? input.truthFiles["story_bible.md"] ?? "", 900),
    weight: 12,
    evidence: evidenceFromFile("book.json", input.title),
  });

  const selectedChapters = selectChapters(input.chapters);
  for (const chapter of selectedChapters) {
    const chapterId = `chapter:${chapter.number}`;
    addNode({
      id: chapterId,
      type: "chapter",
      label: `第${chapter.number}章`,
      subtitle: chapter.title,
      status: chapter.status,
      description: `${chapter.wordCount ?? 0} 字 · ${chapter.status ?? "未标记"}`,
      weight: 4 + Math.min(6, Math.round((chapter.wordCount ?? 0) / 1200)),
      evidence: evidenceFromFile("chapter_index", `${chapter.number}. ${chapter.title}`),
    });
    addEdge({
      id: `${bookNodeId}->${chapterId}`,
      source: bookNodeId,
      target: chapterId,
      type: "contains",
      label: "包含章节",
      strength: 0.35,
    });
  }

  const characters = extractCharacters(input.truthFiles);
  for (const character of characters.slice(0, MAX_CHARACTERS)) {
    const id = `character:${slugify(character.label)}`;
    addNode({
      id,
      type: "character",
      label: character.label,
      subtitle: character.subtitle,
      description: character.description,
      status: character.status,
      weight: character.weight ?? 7,
      evidence: evidenceFromFile(character.source, character.excerpt),
    });
    addEdge({
      id: `${id}->${bookNodeId}`,
      source: id,
      target: bookNodeId,
      type: "relates",
      label: "属于本书",
      strength: 0.55,
    });
  }

  const hooks = extractHooks(input.truthFiles);
  for (const hook of hooks.slice(0, MAX_HOOKS)) {
    const id = `hook:${slugify(hook.label)}`;
    addNode({
      id,
      type: "hook",
      label: hook.label,
      subtitle: hook.subtitle,
      description: hook.description,
      status: hook.status,
      weight: hook.weight ?? 6,
      evidence: evidenceFromFile(hook.source, hook.excerpt),
    });
    addEdge({
      id: `${bookNodeId}->${id}`,
      source: bookNodeId,
      target: id,
      type: "advances",
      label: "伏笔债务",
      strength: hook.status?.includes("逾期") ? 0.9 : 0.62,
    });
  }

  const rules = extractRules(input.truthFiles);
  for (const rule of rules.slice(0, MAX_RULES)) {
    const id = `rule:${slugify(rule.label)}`;
    addNode({
      id,
      type: "rule",
      label: rule.label,
      subtitle: rule.subtitle ?? "创作约束",
      description: rule.description,
      status: rule.status,
      weight: rule.weight ?? 5,
      evidence: evidenceFromFile(rule.source, rule.excerpt),
    });
    addEdge({
      id: `${id}->${bookNodeId}`,
      source: id,
      target: bookNodeId,
      type: "governs",
      label: "约束故事",
      strength: 0.48,
    });
  }

  const stateNode = extractCurrentState(input.truthFiles);
  if (stateNode) {
    const id = "state:current";
    addNode({
      id,
      type: "state",
      label: "当前状态",
      subtitle: stateNode.subtitle,
      description: stateNode.description,
      status: stateNode.status,
      weight: 8,
      evidence: evidenceFromFile(stateNode.source, stateNode.excerpt),
    });
    addEdge({
      id: `${id}->${bookNodeId}`,
      source: id,
      target: bookNodeId,
      type: "focuses",
      label: "当前锚点",
      strength: 0.78,
    });
  }

  const themes = extractThemes(input.truthFiles);
  for (const theme of themes.slice(0, MAX_THEMES)) {
    const id = `theme:${slugify(theme.label)}`;
    addNode({
      id,
      type: "theme",
      label: theme.label,
      subtitle: theme.subtitle ?? "主题信号",
      description: theme.description,
      weight: theme.weight ?? 4,
      evidence: evidenceFromFile(theme.source, theme.excerpt, 2600),
    });
    addEdge({
      id: `${id}->${bookNodeId}`,
      source: id,
      target: bookNodeId,
      type: "relates",
      label: "主题牵引",
      strength: 0.42,
    });
  }

  connectMentions(nodes, edges, selectedChapters, input.truthFiles);

  const nodeList = [...nodes.values()];
  const stats: StoryGraphStats = {
    characters: nodeList.filter((node) => node.type === "character").length,
    chapters: nodeList.filter((node) => node.type === "chapter").length,
    hooks: nodeList.filter((node) => node.type === "hook").length,
    rules: nodeList.filter((node) => node.type === "rule").length,
    unresolvedHooks: nodeList.filter((node) => node.type === "hook" && !/完成|回收|关闭/u.test(node.status ?? "")).length,
    evidenceFiles: Object.values(input.truthFiles).filter((content) => content.trim().length > 0).length,
  };

  return {
    schemaVersion: 1,
    bookId: input.bookId,
    title: input.title,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    stats,
    layers: (Object.keys(TYPE_LABELS) as StoryGraphNodeType[]).map((key) => ({
      key,
      label: TYPE_LABELS[key],
      count: nodeList.filter((node) => node.type === key).length,
    })).filter((layer) => layer.count > 0),
    nodes: nodeList.sort((left, right) => typeRank(left.type) - typeRank(right.type) || right.weight - left.weight),
    edges: [...edges.values()],
  };
}

function extractCharacters(files: Readonly<Record<string, string>>): Candidate[] {
  const matrix = files["character_matrix.md"] ?? "";
  const rows = parseMarkdownRows(matrix);
  const candidates: Candidate[] = [];

  for (const row of rows) {
    const name = cleanCell(row[0] ?? "");
    if (!isUsefulName(name)) continue;
    candidates.push({
      label: name,
      subtitle: cleanCell(row[1] ?? row[2] ?? ""),
      description: row.slice(1).map(cleanCell).filter(Boolean).join("；"),
      status: cleanCell(row.at(-1) ?? ""),
      source: "character_matrix.md",
      excerpt: row.join(" | "),
      weight: 8,
    });
  }

  if (candidates.length > 0) {
    return uniqueCandidates(candidates);
  }

  const fallback = `${files["story_bible.md"] ?? ""}\n${files["current_state.md"] ?? ""}`;
  const names = [...fallback.matchAll(/(?:主角|女主|角色|人物|关系|与)(?:：|:|\s)*([\u4e00-\u9fa5]{2,4})/gu)]
    .map((match) => match[1])
    .filter(isUsefulName);

  return uniqueCandidates(names.map((name) => ({
    label: name,
    subtitle: "从故事设定中识别",
    description: findExcerpt(fallback, name),
    source: "story_bible.md",
    excerpt: findExcerpt(fallback, name),
    weight: 5,
  })));
}

function extractHooks(files: Readonly<Record<string, string>>): Candidate[] {
  const content = files["pending_hooks.md"] ?? "";
  const rows = parseMarkdownRows(content);
  const fromRows = rows
    .map((row): Candidate | null => {
      const id = cleanCell(row[0] ?? "");
      const title = cleanCell(row[1] ?? row[2] ?? "");
      if (!/hook|h\d+|伏笔/iu.test(id) && !title) return null;
      const label = title || id;
      return {
        label,
        subtitle: id,
        description: row.slice(1).map(cleanCell).filter(Boolean).join("；"),
        status: cleanCell(row.find((cell) => /逾期|待|推进|回收|完成|立即|短期|中程/u.test(cell)) ?? ""),
        source: "pending_hooks.md",
        excerpt: row.join(" | "),
        weight: /逾期|立即|高/u.test(row.join("")) ? 8 : 6,
      };
    })
    .filter((candidate): candidate is Candidate => candidate !== null);

  if (fromRows.length > 0) {
    return uniqueCandidates(fromRows);
  }

  const lines = content.split(/\r?\n/u).filter((line) => /hook|伏笔|悬念|回收/iu.test(line));
  return uniqueCandidates(lines.map((line, index) => ({
    label: compactText(line.replace(/^[-*#\s]+/u, ""), 34) || `伏笔 ${index + 1}`,
    subtitle: "待追踪",
    description: compactText(line, 220),
    source: "pending_hooks.md",
    excerpt: line,
    weight: /逾期|立即|高/u.test(line) ? 8 : 5,
  })));
}

function extractRules(files: Readonly<Record<string, string>>): Candidate[] {
  const content = files["book_rules.md"] ?? "";
  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /禁止|必须|核心|规则|约束|风格|视角|节奏/u.test(line))
    .filter((line) => !/^---$/u.test(line));

  return uniqueCandidates(lines.map((line) => {
    const cleaned = line.replace(/^[-*#\d.\s]+/u, "").replace(/\*\*/gu, "");
    return {
      label: compactText(cleaned, 26),
      subtitle: /禁止/u.test(cleaned) ? "硬性禁区" : "创作规则",
      description: cleaned,
      source: "book_rules.md",
      excerpt: line,
      weight: /禁止|必须/u.test(cleaned) ? 7 : 5,
    };
  }));
}

function extractCurrentState(files: Readonly<Record<string, string>>): Candidate | null {
  const content = files["current_state.md"] ?? files["current_focus.md"] ?? "";
  if (!content.trim()) return null;
  const position = findLabelValue(content, "当前位置") ?? findLabelValue(content, "位置");
  const goal = findLabelValue(content, "当前目标") ?? findLabelValue(content, "短期");
  return {
    label: "当前状态",
    subtitle: position ? `位置：${compactText(position, 24)}` : "最新状态卡",
    description: compactText(goal ? `${position ?? ""}\n${goal}` : content, 900),
    status: "active",
    source: files["current_state.md"] ? "current_state.md" : "current_focus.md",
    excerpt: compactText(content, 1400),
    weight: 8,
  };
}

function extractThemes(files: Readonly<Record<string, string>>): Candidate[] {
  const authorIntent = files["author_intent.md"] ?? "";
  const content = `${authorIntent}\n${files["story_bible.md"] ?? ""}\n${files["volume_outline.md"] ?? ""}`;
  const authorFields = extractJsonishFields(authorIntent);
  const phrases = [
    "爽点", "权力", "成长", "家庭", "关系", "悬疑", "救赎", "逆袭", "系统", "伦理", "爱情", "城市", "记忆", "阶层",
  ];
  return phrases
    .filter((phrase) => content.includes(phrase))
    .map((phrase) => {
      const authorField = authorFields.find((field) => field.value.includes(phrase));
      const excerpt = authorField
        ? formatJsonishField(authorField)
        : findExcerpt(content, phrase, 2600, 300, 2200);
      return {
        label: phrase,
        subtitle: "高频主题",
        description: authorField ? formatJsonishField(authorField) : findExcerpt(content, phrase, 2200, 260, 1800),
        source: authorField || authorIntent.includes(phrase) ? "author_intent.md" : "story_bible.md",
        excerpt,
        weight: Math.min(7, 3 + countOccurrences(content, phrase)),
      };
    });
}

function connectMentions(
  nodes: Map<string, StoryGraphNode>,
  edges: Map<string, StoryGraphEdge>,
  chapters: ReadonlyArray<StoryGraphChapterInput>,
  files: Readonly<Record<string, string>>,
) {
  const chapterSummary = files["chapter_summaries.md"] ?? "";
  const chapterTexts = new Map<number, string>();
  for (const chapter of chapters) {
    chapterTexts.set(chapter.number, `${chapter.title}\n${findChapterSummary(chapterSummary, chapter.number)}`);
  }

  for (const node of nodes.values()) {
    if (node.type !== "character" && node.type !== "hook" && node.type !== "theme") continue;
    for (const chapter of chapters) {
      const text = chapterTexts.get(chapter.number) ?? "";
      if (!text.includes(node.label) && !(node.subtitle && text.includes(node.subtitle))) continue;
      const chapterId = `chapter:${chapter.number}`;
      if (!nodes.has(chapterId)) continue;
      edges.set(`${node.id}->${chapterId}`, {
        id: `${node.id}->${chapterId}`,
        source: node.id,
        target: chapterId,
        type: node.type === "character" ? "appears_in" : "advances",
        label: node.type === "character" ? "出场" : "推进",
        strength: node.type === "character" ? 0.64 : 0.58,
      });
    }
  }
}

function parseMarkdownRows(content: string): string[][] {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) => line.slice(1, -1).split("|").map(cleanCell))
    .filter((cells) => cells.length > 1)
    .filter((cells) => !cells.every((cell) => /^:?-{2,}:?$/u.test(cell)))
    .filter((cells) => !cells.some((cell) => /角色|字段|章节|hook_id|伏笔池/u.test(cell)) || cells.some((cell) => /万凡|苏|林|孟|陈|赵|周/u.test(cell)));
}

function cleanCell(value: string): string {
  return value.replace(/<br\s*\/?>/giu, " ").replace(/\*\*/gu, "").replace(/`/gu, "").trim();
}

function isUsefulName(value: string): boolean {
  if (!value || value.length > 12) return false;
  if (/^(角色|姓名|人物|主角|女主|配角|关系|字段|值|章节)$/u.test(value)) return false;
  if (/[-|:：]/u.test(value)) return false;
  return /[\u4e00-\u9fa5]/u.test(value);
}

function uniqueCandidates(candidates: ReadonlyArray<Candidate>): Candidate[] {
  const seen = new Set<string>();
  const result: Candidate[] = [];
  for (const candidate of candidates) {
    const key = candidate.label.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function selectChapters(chapters: ReadonlyArray<StoryGraphChapterInput>): StoryGraphChapterInput[] {
  const sorted = [...chapters].sort((left, right) => left.number - right.number);
  if (sorted.length <= MAX_CHAPTERS) return sorted;
  return sorted.slice(0, 10).concat(sorted.slice(-50));
}

function findChapterSummary(content: string, chapterNumber: number): string {
  if (!content.trim()) return "";
  const rows = parseMarkdownRows(content);
  const row = rows.find((cells) => cells.some((cell) => cell === String(chapterNumber) || cell === `第${chapterNumber}章`));
  if (row) return row.join(" ");
  const regex = new RegExp(`第?${chapterNumber}章[^\\n]*(?:\\n[^#|\\n].*){0,4}`, "u");
  return content.match(regex)?.[0] ?? "";
}

function findLabelValue(content: string, label: string): string | null {
  const regex = new RegExp(`${label}\\s*[：:]\\s*([^\\n]+)`, "u");
  return content.match(regex)?.[1]?.trim() ?? null;
}

function extractJsonishFields(content: string): Array<{ key: string; value: string }> {
  const trimmed = content.trim();
  if (!trimmed.includes(":")) return [];

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.entries(parsed as Record<string, unknown>)
        .map(([key, value]) => ({ key, value: stringifyJsonishValue(value) }))
        .filter((field) => field.value.length > 0);
    }
  } catch {
    // Fall back to regex extraction for slightly malformed truth files.
  }

  return [...trimmed.matchAll(/"?([A-Za-z][\w.-]*)"?\s*:\s*"([\s\S]*?)"\s*(?=,\s*"?[A-Za-z][\w.-]*"?\s*:|$)/gu)]
    .map((match) => ({ key: match[1] ?? "", value: cleanJsonishValue(match[2] ?? "") }))
    .filter((field) => field.key && field.value);
}

function stringifyJsonishValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(stringifyJsonishValue).filter(Boolean).join("\n");
  if (value && typeof value === "object") return JSON.stringify(value);
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function formatJsonishField(field: { readonly key: string; readonly value: string }): string {
  const escaped = field.value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, "\\n");
  return `"${field.key}": "${escaped}"`;
}

function cleanJsonishValue(value: string): string {
  return value
    .replace(/\\n/gu, "\n")
    .replace(/\\"/gu, '"')
    .replace(/[ \t]+/gu, " ")
    .trim();
}

function findExcerpt(
  content: string,
  term: string,
  maxLength = 900,
  before = 180,
  after = 520,
): string {
  const index = content.indexOf(term);
  if (index < 0) return compactText(content, 700);
  return compactText(content.slice(Math.max(0, index - before), index + term.length + after), maxLength);
}

function countOccurrences(content: string, term: string): number {
  return content.split(term).length - 1;
}

function compactText(value: string, maxLength: number): string {
  const text = value.replace(/\s+/gu, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function evidenceFromFile(source: string, excerpt: string, maxLength = 1400): ReadonlyArray<StoryGraphEvidence> {
  const normalized = compactText(excerpt, maxLength);
  return normalized ? [{ source, excerpt: normalized }] : [];
}

function mergeEvidence(
  left: ReadonlyArray<StoryGraphEvidence>,
  right: ReadonlyArray<StoryGraphEvidence>,
): ReadonlyArray<StoryGraphEvidence> {
  const seen = new Set<string>();
  return [...left, ...right].filter((item) => {
    const key = `${item.source}:${item.excerpt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5);
}

function slugify(value: string): string {
  return encodeURIComponent(value.trim().toLowerCase()).replace(/%/gu, "");
}

function typeRank(type: StoryGraphNodeType): number {
  return ["book", "state", "character", "chapter", "hook", "rule", "theme"].indexOf(type);
}
