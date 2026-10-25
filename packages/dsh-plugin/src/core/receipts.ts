import { LIMITS } from '@dsh-remote/protocol';
import type { Clock } from './clock.ts';
import type { PromptProgress } from './events.ts';
import type { DocumentStore } from './store.ts';

export type ReceiptState = 'submitting' | 'queued' | 'started' | 'finished' | 'failed';

export interface Receipt {
  readonly clientRequestId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly textSha256: string;
  /** Also the DSH request id persisted on the accepted user message. */
  readonly turnId: string;
  readonly createdAt: number;
  state: ReceiptState;
  turn?: number;
}

export interface ReceiptsDocument {
  readonly version: 1;
  receipts: Receipt[];
}

const ORDER: Record<ReceiptState, number> = { submitting: 0, queued: 1, started: 2, finished: 3, failed: 3 };

/**
 * Idempotency receipts (spec §6), kept 24 h. A receipt is persisted *before*
 * DSH sees the prompt, so an exact retry after any crash or timeout returns
 * the original turn instead of submitting again — DSH itself would run a
 * retried request id a second time.
 */
export class Receipts {
  private readonly store: DocumentStore<ReceiptsDocument>;
  private readonly clock: Clock;
  private doc: ReceiptsDocument;

  private constructor(store: DocumentStore<ReceiptsDocument>, clock: Clock, doc: ReceiptsDocument) {
    this.store = store;
    this.clock = clock;
    this.doc = doc;
  }

  static async open(store: DocumentStore<ReceiptsDocument>, clock: Clock): Promise<Receipts> {
    const doc = (await store.read()) ?? { version: 1, receipts: [] };
    const receipts = new Receipts(store, clock, doc);
    receipts.prune();
    return receipts;
  }

  get(deviceId: string, clientRequestId: string): Receipt | undefined {
    return this.doc.receipts.find((r) => r.deviceId === deviceId && r.clientRequestId === clientRequestId);
  }

  byTurn(turnId: string): Receipt | undefined {
    return this.doc.receipts.find((r) => r.turnId === turnId);
  }

  async create(receipt: Omit<Receipt, 'createdAt' | 'state'>): Promise<Receipt> {
    this.prune();
    const created: Receipt = { ...receipt, createdAt: this.clock.now(), state: 'submitting' };
    this.doc.receipts.push(created);
    await this.store.write(this.doc);
    return created;
  }

  /** Move a receipt forward; states never move backwards. */
  async advance(turnId: string, state: ReceiptState, turn?: number): Promise<void> {
    const receipt = this.byTurn(turnId);
    if (receipt === undefined || ORDER[state] <= ORDER[receipt.state]) return;
    receipt.state = state;
    if (turn !== undefined) receipt.turn = turn;
    await this.store.write(this.doc);
  }

  /** Feed observed prompt progress from the session log. */
  observe(progress: PromptProgress): void {
    void this.advance(progress.requestId, progress.state, progress.turn).catch(() => {});
  }

  private prune(): void {
    const cutoff = this.clock.now() - LIMITS.receiptTtlMs;
    this.doc.receipts = this.doc.receipts.filter((r) => r.createdAt > cutoff);
  }
}
