export type TaskNodeStatus = "pending" | "running" | "waiting_approval" | "succeeded" | "failed";
export type TaskRunStatus = "pending" | "running" | "waiting_approval" | "succeeded" | "failed";
export type TaskNodeType = "task" | "checkpoint";

export interface CheckpointState {
  readonly nodeId: string;
  readonly requiredApproval: boolean;
  readonly approvedAt?: string;
  readonly approvedBy?: string;
  /** ID of the blueprint artifact that must be confirmed before this checkpoint can be approved. */
  readonly blueprintArtifactId?: string;
  /** The payload status value required (default "confirmed"). */
  readonly requiredBlueprintStatus?: string;
}

export interface TaskNode {
  readonly nodeId: string;
  readonly type: TaskNodeType;
  readonly action: string;
  readonly bookId?: string;
  readonly bookIds?: ReadonlyArray<string>;
  readonly chapter?: number;
  readonly mode?: string;
  readonly parallelCandidates?: number;
  readonly planInput?: string;
  readonly brief?: string;
  readonly steeringContract?: Record<string, unknown>;
  readonly blueprint?: Record<string, unknown>;
  readonly sourceArtifactIds?: ReadonlyArray<string>;
  readonly dependsOn?: ReadonlyArray<string>;
  readonly maxRetries?: number;
  readonly checkpoint?: CheckpointState;
}

export interface TaskEdge {
  readonly from: string;
  readonly to: string;
}

export interface TaskGraph {
  readonly taskId: string;
  readonly nodes: ReadonlyArray<TaskNode>;
  readonly edges: ReadonlyArray<TaskEdge>;
  readonly intent?: string;
  readonly intentType?: string;
  readonly riskLevel?: string;
}

export interface TaskNodeRuntimeState {
  readonly nodeId: string;
  readonly type: TaskNodeType;
  readonly action: string;
  readonly bookId?: string;
  readonly bookIds?: ReadonlyArray<string>;
  readonly chapter?: number;
  readonly mode?: string;
  readonly parallelCandidates?: number;
  readonly planInput?: string;
  readonly brief?: string;
  readonly steeringContract?: Record<string, unknown>;
  readonly blueprint?: Record<string, unknown>;
  readonly sourceArtifactIds?: ReadonlyArray<string>;
  readonly maxRetries: number;
  readonly attempts: number;
  readonly status: TaskNodeStatus;
  readonly runId?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: string;
  readonly checkpoint?: CheckpointState;
}

export interface TaskRunState {
  readonly taskId: string;
  readonly sessionId: string;
  readonly graph: TaskGraph;
  readonly status: TaskRunStatus;
  readonly currentNodeId?: string;
  readonly nodes: Record<string, TaskNodeRuntimeState>;
  readonly stepRunIds: Record<string, string>;
  readonly lastUpdatedAt: string;
  readonly error?: string;
}

export interface PreparedTaskNodeExecution {
  readonly runId?: string;
  readonly execute: () => Promise<void>;
}

export interface PrepareTaskNodeContext {
  readonly taskId: string;
  readonly sessionId: string;
  readonly attempt: number;
}

export interface AssistantConductorOptions {
  readonly sessionId: string;
  readonly autoApproveCheckpoints?: boolean;
  readonly pauseAfterConsecutiveFailures?: number;
}

export interface AssistantConductorDependencies {
  readonly prepareNode: (
    node: TaskNode,
    context: PrepareTaskNodeContext,
  ) => Promise<PreparedTaskNodeExecution>;
  readonly now?: () => string;
}

export type AssistantConductorEvent =
  | {
      readonly type: "node";
      readonly phase: "start" | "success" | "fail";
      readonly taskId: string;
      readonly sessionId: string;
      readonly nodeId: string;
      readonly nodeType: TaskNodeType;
      readonly action: string;
      readonly nodeStatus: TaskNodeStatus;
      readonly attempts: number;
      readonly maxRetries: number;
      readonly timestamp: string;
      readonly runId?: string;
      readonly error?: string;
      readonly bookId?: string;
      readonly bookIds?: ReadonlyArray<string>;
      readonly chapter?: number;
      readonly mode?: string;
      readonly checkpoint?: CheckpointState;
      readonly retryContext?: Record<string, unknown>;
    }
  | {
      readonly type: "graph";
      readonly phase: "done";
      readonly taskId: string;
      readonly sessionId: string;
      readonly status: Exclude<TaskRunStatus, "pending" | "running" | "waiting_approval">;
      readonly timestamp: string;
      readonly error?: string;
      readonly errorCode?: string;
      readonly reasonCode?: string;
    };

interface MutableTaskNodeRuntimeState {
  nodeId: string;
  type: TaskNodeType;
  action: string;
  bookId?: string;
  bookIds?: ReadonlyArray<string>;
  chapter?: number;
  mode?: string;
  parallelCandidates?: number;
  planInput?: string;
  brief?: string;
  steeringContract?: Record<string, unknown>;
  blueprint?: Record<string, unknown>;
  sourceArtifactIds?: ReadonlyArray<string>;
  maxRetries: number;
  attempts: number;
  status: TaskNodeStatus;
  runId?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  checkpoint?: CheckpointState;
}

interface MutableTaskRunState {
  taskId: string;
  sessionId: string;
  graph: TaskGraph;
  status: TaskRunStatus;
  currentNodeId?: string;
  nodes: Record<string, MutableTaskNodeRuntimeState>;
  stepRunIds: Record<string, string>;
  lastUpdatedAt: string;
  error?: string;
  approvalResolvers: Map<string, () => void>;
  consecutiveFailures: number;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeFailureThreshold(input: number | undefined): number | undefined {
  return typeof input === "number" && Number.isFinite(input) && input > 0 ? input : undefined;
}

function cloneCheckpoint(checkpoint: CheckpointState | undefined): CheckpointState | undefined {
  return checkpoint ? { ...checkpoint } : undefined;
}

function cloneNodeState(node: MutableTaskNodeRuntimeState): TaskNodeRuntimeState {
  return {
    ...node,
    ...(node.bookIds ? { bookIds: [...node.bookIds] } : {}),
    ...(node.checkpoint ? { checkpoint: cloneCheckpoint(node.checkpoint) } : {}),
    ...(node.steeringContract ? { steeringContract: { ...node.steeringContract } } : {}),
    ...(node.blueprint ? { blueprint: { ...node.blueprint } } : {}),
    ...(node.sourceArtifactIds ? { sourceArtifactIds: [...node.sourceArtifactIds] } : {}),
  };
}

function cloneRunState(run: MutableTaskRunState): TaskRunState {
  return {
    taskId: run.taskId,
    sessionId: run.sessionId,
    graph: run.graph,
    status: run.status,
    ...(run.currentNodeId ? { currentNodeId: run.currentNodeId } : {}),
    nodes: Object.fromEntries(Object.entries(run.nodes).map(([nodeId, node]) => [nodeId, cloneNodeState(node)])),
    stepRunIds: { ...run.stepRunIds },
    lastUpdatedAt: run.lastUpdatedAt,
    ...(run.error ? { error: run.error } : {}),
  };
}

export class AssistantConductor {
  private readonly graphs = new Map<string, TaskGraph>();
  private readonly runs = new Map<string, MutableTaskRunState>();
  private readonly now: () => string;

  constructor(private readonly dependencies: AssistantConductorDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  registerGraph(graph: TaskGraph): void {
    this.graphs.set(graph.taskId, graph);
  }

  getGraph(taskId: string): TaskGraph | undefined {
    return this.graphs.get(taskId);
  }

  getRunState(taskId: string): TaskRunState | undefined {
    const run = this.runs.get(taskId);
    return run ? cloneRunState(run) : undefined;
  }

  approve(taskId: string, nodeId: string, approvedBy = "manual"): boolean {
    const run = this.runs.get(taskId);
    const node = run?.nodes[nodeId];
    if (!run || !node || node.type !== "checkpoint" || node.status !== "waiting_approval") {
      return false;
    }
    const approvedAt = this.now();
    node.checkpoint = {
      nodeId,
      requiredApproval: true,
      approvedAt,
      approvedBy,
    };
    node.finishedAt = approvedAt;
    run.lastUpdatedAt = approvedAt;
    const resume = run.approvalResolvers.get(nodeId);
    if (resume) {
      run.approvalResolvers.delete(nodeId);
      resume();
    }
    return true;
  }

  async *runGraph(graph: TaskGraph, options: AssistantConductorOptions): AsyncGenerator<AssistantConductorEvent> {
    this.graphs.set(graph.taskId, graph);
    const run = this.createRunState(graph, options.sessionId);
    this.runs.set(graph.taskId, run);

    const dependencies = new Map<string, Set<string>>();
    graph.nodes.forEach((node) => {
      dependencies.set(node.nodeId, new Set(node.dependsOn ?? []));
    });
    graph.edges.forEach((edge) => {
      if (!dependencies.has(edge.to)) {
        dependencies.set(edge.to, new Set());
      }
      dependencies.get(edge.to)?.add(edge.from);
    });
    const orderedNodes = [...graph.nodes].sort((left, right) => left.nodeId.localeCompare(right.nodeId));

    while (true) {
      const readyNodes = orderedNodes.filter((node) => {
        const state = run.nodes[node.nodeId];
        if (!state || state.status !== "pending") {
          return false;
        }
        return [...(dependencies.get(node.nodeId) ?? new Set())]
          .every((dependencyNodeId) => run.nodes[dependencyNodeId]?.status === "succeeded");
      });

      if (readyNodes.length === 0) {
        if (Object.values(run.nodes).every((node) => node.status === "succeeded")) {
          const timestamp = this.now();
          run.status = "succeeded";
          run.lastUpdatedAt = timestamp;
          yield {
            type: "graph",
            phase: "done",
            taskId: run.taskId,
            sessionId: run.sessionId,
            status: "succeeded",
            timestamp,
          };
          return;
        }
        if (Object.values(run.nodes).some((node) => node.status === "failed")) {
          const timestamp = this.now();
          run.status = "failed";
          run.lastUpdatedAt = timestamp;
          yield {
            type: "graph",
            phase: "done",
            taskId: run.taskId,
            sessionId: run.sessionId,
            status: "failed",
            timestamp,
            ...(run.error ? { error: run.error } : {}),
          };
          return;
        }
        const waitingNode = orderedNodes.find((node) => run.nodes[node.nodeId]?.status === "waiting_approval");
        if (waitingNode) {
          await new Promise<void>((resolve) => {
            run.approvalResolvers.set(waitingNode.nodeId, resolve);
          });
          continue;
        }

        const timestamp = this.now();
        run.status = "failed";
        run.lastUpdatedAt = timestamp;
        run.error = "Task graph could not make progress due to unmet dependencies.";
        yield {
          type: "graph",
          phase: "done",
          taskId: run.taskId,
          sessionId: run.sessionId,
          status: "failed",
          timestamp,
          error: run.error,
        };
        return;
      }

      for (const node of readyNodes) {
        if (node.type === "checkpoint") {
          yield* this.runCheckpointNode(run, node, options.autoApproveCheckpoints === true);
          continue;
        }
        const terminalEvent = yield* this.runTaskNode(run, node, options);
        if (terminalEvent) {
          yield terminalEvent;
          return;
        }
      }
    }
  }

  private createRunState(graph: TaskGraph, sessionId: string): MutableTaskRunState {
    const timestamp = this.now();
    return {
      taskId: graph.taskId,
      sessionId,
      graph,
      status: "pending",
      nodes: Object.fromEntries(graph.nodes.map((node) => [
        node.nodeId,
        {
          nodeId: node.nodeId,
          type: node.type,
          action: node.action,
          ...(node.bookId ? { bookId: node.bookId } : {}),
          ...(node.bookIds ? { bookIds: [...node.bookIds] } : {}),
          ...(node.chapter !== undefined ? { chapter: node.chapter } : {}),
          ...(node.mode ? { mode: node.mode } : {}),
          ...(node.parallelCandidates !== undefined ? { parallelCandidates: node.parallelCandidates } : {}),
          ...(node.planInput ? { planInput: node.planInput } : {}),
          ...(node.brief ? { brief: node.brief } : {}),
          ...(node.steeringContract ? { steeringContract: node.steeringContract } : {}),
          ...(node.blueprint ? { blueprint: node.blueprint } : {}),
          ...(node.sourceArtifactIds ? { sourceArtifactIds: [...node.sourceArtifactIds] } : {}),
          maxRetries: Math.max(node.maxRetries ?? 0, 0),
          attempts: 0,
          status: "pending",
          ...(node.checkpoint ? { checkpoint: cloneCheckpoint(node.checkpoint) } : {}),
        } satisfies MutableTaskNodeRuntimeState,
      ])),
      stepRunIds: {},
      lastUpdatedAt: timestamp,
      approvalResolvers: new Map<string, () => void>(),
      consecutiveFailures: 0,
    };
  }

  private async *runCheckpointNode(
    run: MutableTaskRunState,
    node: TaskNode,
    autoApprove: boolean,
  ): AsyncGenerator<AssistantConductorEvent> {
    const state = run.nodes[node.nodeId]!;
    const checkpointRequiresManualApproval = node.checkpoint?.requiredBlueprintStatus === "confirmed"
      || Boolean(node.checkpoint?.blueprintArtifactId);
    const shouldAutoApprove = autoApprove && !checkpointRequiresManualApproval;
    const startedAt = this.now();
    state.attempts += 1;
    state.startedAt ??= startedAt;
    state.status = shouldAutoApprove ? "running" : "waiting_approval";
    state.checkpoint = {
      ...(node.checkpoint ?? {}),
      nodeId: node.nodeId,
      requiredApproval: true,
      ...(shouldAutoApprove ? { approvedAt: startedAt, approvedBy: "auto" } : {}),
    };
    run.status = shouldAutoApprove ? "running" : "waiting_approval";
    run.currentNodeId = node.nodeId;
    run.lastUpdatedAt = startedAt;
    yield this.buildNodeEvent(run, state, "start", startedAt);

    if (!shouldAutoApprove) {
      await new Promise<void>((resolve) => {
        run.approvalResolvers.set(node.nodeId, resolve);
      });
    }

    const finishedAt = this.now();
    state.status = "succeeded";
    state.finishedAt = finishedAt;
    state.checkpoint = {
      ...(state.checkpoint ?? node.checkpoint ?? {}),
      nodeId: node.nodeId,
      requiredApproval: true,
      approvedAt: state.checkpoint?.approvedAt ?? finishedAt,
      approvedBy: state.checkpoint?.approvedBy ?? (shouldAutoApprove ? "auto" : "manual"),
    };
    run.status = "running";
    run.currentNodeId = node.nodeId;
    run.lastUpdatedAt = finishedAt;
    run.consecutiveFailures = 0;
    yield this.buildNodeEvent(run, state, "success", finishedAt);
  }

  private async *runTaskNode(
    run: MutableTaskRunState,
    node: TaskNode,
    options: AssistantConductorOptions,
  ): AsyncGenerator<AssistantConductorEvent, AssistantConductorEvent | null> {
    const state = run.nodes[node.nodeId]!;

    while (state.attempts <= state.maxRetries) {
      try {
        const prepared = await this.dependencies.prepareNode(node, {
          taskId: run.taskId,
          sessionId: run.sessionId,
          attempt: state.attempts + 1,
        });
        state.attempts += 1;
        state.runId = prepared.runId;
        if (prepared.runId) {
          run.stepRunIds[node.nodeId] = prepared.runId;
        }
        state.status = "running";
        state.error = undefined;
        state.finishedAt = undefined;
        state.startedAt ??= this.now();
        run.status = "running";
        run.currentNodeId = node.nodeId;
        run.lastUpdatedAt = this.now();
        yield this.buildNodeEvent(run, state, "start", run.lastUpdatedAt);

        await prepared.execute();

        const finishedAt = this.now();
        state.status = "succeeded";
        state.finishedAt = finishedAt;
        run.status = "running";
        run.currentNodeId = node.nodeId;
        run.lastUpdatedAt = finishedAt;
        run.consecutiveFailures = 0;
        yield this.buildNodeEvent(run, state, "success", finishedAt);
        return null;
      } catch (error) {
        const finishedAt = this.now();
        const message = toErrorMessage(error);
        // prepareNode failures happen before the attempt is counted, while execute()
        // failures happen after we have already incremented attempts for this run.
        if (state.status !== "running") {
          state.attempts += 1;
        }
        state.error = message;
        state.finishedAt = finishedAt;
        run.consecutiveFailures += 1;
        const hasRetryRemaining = state.attempts <= state.maxRetries;
        const pauseAfterConsecutiveFailures = normalizeFailureThreshold(
          options.pauseAfterConsecutiveFailures,
        );
        const autopilotPauseTriggered = pauseAfterConsecutiveFailures !== undefined
          && run.consecutiveFailures >= pauseAfterConsecutiveFailures;
        state.status = hasRetryRemaining ? "pending" : "failed";
        run.lastUpdatedAt = finishedAt;
        if (autopilotPauseTriggered || !hasRetryRemaining) {
          state.status = "failed";
          run.status = "failed";
          run.currentNodeId = node.nodeId;
          run.error = autopilotPauseTriggered
            ? `Autopilot paused after ${run.consecutiveFailures} consecutive failures.`
            : message;
        }
        yield this.buildNodeEvent(run, state, "fail", finishedAt, {
          currentAttempt: state.attempts,
          maxRetries: state.maxRetries,
          retryScheduled: hasRetryRemaining && !autopilotPauseTriggered,
          consecutiveFailures: run.consecutiveFailures,
          ...(pauseAfterConsecutiveFailures !== undefined ? { pauseAfterConsecutiveFailures } : {}),
          ...(autopilotPauseTriggered ? { autopilotPaused: true } : {}),
        });
        if (autopilotPauseTriggered) {
          return {
            type: "graph",
            phase: "done",
            taskId: run.taskId,
            sessionId: run.sessionId,
            status: "failed",
            timestamp: finishedAt,
            error: run.error,
            errorCode: "ASSISTANT_AUTOPILOT_FAILURE_THRESHOLD_REACHED",
            reasonCode: "autopilot-consecutive-failures",
          };
        }
        if (!hasRetryRemaining) {
          return {
            type: "graph",
            phase: "done",
            taskId: run.taskId,
            sessionId: run.sessionId,
            status: "failed",
            timestamp: finishedAt,
            error: message,
          };
        }
      }
    }

    return null;
  }

  private buildNodeEvent(
    run: MutableTaskRunState,
    node: MutableTaskNodeRuntimeState,
    phase: "start" | "success" | "fail",
    timestamp: string,
    retryContext?: Record<string, unknown>,
  ): AssistantConductorEvent {
    return {
      type: "node",
      phase,
      taskId: run.taskId,
      sessionId: run.sessionId,
      nodeId: node.nodeId,
      nodeType: node.type,
      action: node.action,
      nodeStatus: node.status,
      attempts: node.attempts,
      maxRetries: node.maxRetries,
      timestamp,
      ...(node.runId ? { runId: node.runId } : {}),
      ...(node.error ? { error: node.error } : {}),
      ...(node.bookId ? { bookId: node.bookId } : {}),
      ...(node.bookIds ? { bookIds: [...node.bookIds] } : {}),
      ...(node.chapter !== undefined ? { chapter: node.chapter } : {}),
      ...(node.mode ? { mode: node.mode } : {}),
      ...(node.checkpoint ? { checkpoint: cloneCheckpoint(node.checkpoint) } : {}),
      ...(retryContext ? { retryContext } : {}),
    };
  }
}
