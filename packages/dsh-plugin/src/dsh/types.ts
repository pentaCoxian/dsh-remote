/**
 * Structural view of the DSH 0.2.1-rc.3 host services this plugin calls
 * (docs/dsh-adapter-findings.md). Declared locally so the plugin does not
 * compile against DSH internals; the integration test against the pinned
 * host is what proves the contract.
 */

export interface DshPeer {
  readonly principal: unknown;
  dispose(): Promise<void>;
}

export interface DshSessionSummary {
  readonly sessionId: string;
  readonly running: boolean;
  readonly agentAvailable: boolean;
  readonly updatedAt: number;
  readonly blank: boolean;
  readonly origin?: 'subagent';
  readonly cwd?: string;
  readonly projections?: { readonly values?: Record<string, unknown> };
}

export interface DshWireEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: unknown;
}

export type DshFollowFrame =
  | { readonly type: 'snapshot'; readonly cursor: number; readonly records: readonly { readonly type: 'event'; readonly event: DshWireEvent }[]; readonly hasMore: boolean }
  | { readonly type: 'event'; readonly event: DshWireEvent }
  | { readonly type: 'assistant-stream'; readonly frame: DshAssistantFrame };

export type DshAssistantFrame =
  | { readonly type: 'start'; readonly attemptId: string; readonly turn: number; readonly step: number }
  | { readonly type: 'chunk'; readonly attemptId: string; readonly index: number; readonly time: number; readonly chunk: unknown }
  | { readonly type: 'end'; readonly attemptId: string; readonly outcome: { readonly kind: 'committed' | 'abandoned' } };

export interface DshApprovalRequest {
  readonly agent: { readonly id: string; readonly session?: { readonly id: string } };
  readonly toolName: string;
  readonly callId?: string;
  readonly reason?: string;
  signal?: AbortSignal;
}

export type DshApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

export interface DshCommandInvocation {
  readonly commandId: string;
  readonly agent: { readonly id: string; readonly session?: { readonly id: string } };
  readonly rawInput: string;
  readonly signal: AbortSignal;
}

export type DshCommandResult = { readonly kind: 'success'; readonly text?: string } | { readonly kind: 'error'; readonly text: string };

export interface DshFetchRoute {
  readonly path: string;
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[];
  readonly requestBody: 'buffered' | 'streaming';
  readonly fetch: (request: Request) => Promise<Response>;
}

export interface DshRemoteAccessBinding {
  readonly role: { readonly name: string; readonly resource: string; readonly actions: readonly string[] };
  readonly resource: { readonly kind: 'global' } | { readonly kind: string; readonly id: string };
}

export interface DshLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface DshContext {
  readonly sessionController: {
    list(request: Record<string, never>, signal: AbortSignal): Promise<{ readonly items: readonly DshSessionSummary[] }>;
    follow(request: { address: { kind: 'session'; sessionId: string }; assistantStream?: true; maxMessages?: number }, signal: AbortSignal): AsyncIterable<DshFollowFrame>;
  };
  readonly typertGateway: {
    invoke(request: { namespace: string; method: string; args: Record<string, unknown>; peer: DshPeer; signal?: AbortSignal }): Promise<unknown>;
  };
  readonly connection: {
    createPeer(options: { principal: unknown; interactions?: 'answer' | 'none' }): DshPeer;
    readonly fetch: { register(route: DshFetchRoute): () => Promise<void> };
  };
  readonly remoteAccess: {
    registerPolicy(kind: string, policy: { bindings(principal: { deviceId?: unknown }): readonly DshRemoteAccessBinding[] }): () => void;
    invalidate(principal?: unknown): void;
  };
  readonly commands: {
    register(definition: { name: string; description: string; recordInput?: boolean; handler(invocation: DshCommandInvocation): DshCommandResult | Promise<DshCommandResult> }): () => void;
  };
  on(event: 'approval/request', listener: (this: unknown, request: DshApprovalRequest, next: () => Promise<DshApprovalOutcome>) => Promise<DshApprovalOutcome>, options: { prepend: boolean }): () => void;
  effect(execute: () => (() => unknown) | Promise<() => unknown>, label?: string): unknown;
  readonly logger?: DshLogger;
}
