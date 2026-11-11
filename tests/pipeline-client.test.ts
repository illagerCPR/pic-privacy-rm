import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PipelineError } from '../src/core/errors.ts';
import { createPipelineClient } from '../src/lib/pipeline-client.ts';
import type { ScanResult } from '../src/core/types.ts';

class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  readonly messages: Record<string, unknown>[] = [];
  terminated = false;

  constructor() {
    super();
    FakeWorker.instances.push(this);
  }

  postMessage(message: Record<string, unknown>): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(message: Record<string, unknown>): void {
    this.dispatchEvent(new MessageEvent('message', { data: message }));
  }

  crash(): void {
    this.dispatchEvent(new Event('error'));
  }
}

const realWorker = globalThis.Worker;
const realWindow = globalThis.window;

beforeEach(() => {
  FakeWorker.instances = [];
  (globalThis as { Worker: unknown }).Worker = FakeWorker;
  (globalThis as { window: unknown }).window = { setTimeout, clearTimeout };
});

afterEach(() => {
  (globalThis as { Worker: unknown }).Worker = realWorker;
  (globalThis as { window: unknown }).window = realWindow;
});

const file = new File([Uint8Array.from([1, 2, 3])], 'tiny.jpg', { type: 'image/jpeg' });
const scanResult: ScanResult = {
  format: 'jpeg',
  fileSize: 3,
  supported: true,
  findings: [],
  warnings: [],
  orientation: 1,
  blocks: [],
  droppedBytes: 0,
  keptBytes: 3,
  hasC2pa: false,
};

describe('worker pool', () => {
  it('spawns two workers and hands scan jobs out round-robin', async () => {
    const client = createPipelineClient();
    expect(client.mode).toBe('worker');
    expect(FakeWorker.instances).toHaveLength(2);

    const first = client.scan(file);
    const second = client.scan(file);
    expect(FakeWorker.instances[0]!.messages).toHaveLength(1);
    expect(FakeWorker.instances[1]!.messages).toHaveLength(1);

    for (const worker of FakeWorker.instances) {
      const request = worker.messages[0]!;
      worker.reply({ id: request['id'], ok: true, kind: 'scan', scan: scanResult });
    }
    await expect(first).resolves.toEqual(scanResult);
    await expect(second).resolves.toEqual(scanResult);
    client.dispose();
  });

  it('does not rerun a domain error on the main thread', async () => {
    const client = createPipelineClient();
    const promise = client.scan(file);
    const worker = FakeWorker.instances[0]!;
    const request = worker.messages[0]!;
    worker.reply({
      id: request['id'],
      ok: false,
      error: { code: 'unreadable', params: { warning: 'warn.x' } },
    });
    await expect(promise).rejects.toMatchObject({ code: 'unreadable' });
    client.dispose();
  });

  it('falls back to the main thread when a worker crashes', async () => {
    const client = createPipelineClient();
    const promise = client.scan(file);
    FakeWorker.instances[0]!.crash();
    const result = await promise;
    // The inline scan sees a three-byte file and reports it as unsupported.
    expect(result.format).toBe('unknown');
    expect(result.supported).toBe(false);
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
    client.dispose();
  });

  it('rejects pending work when disposed', async () => {
    const client = createPipelineClient();
    const promise = client.scan(file);
    client.dispose();
    await expect(promise).rejects.toBeInstanceOf(PipelineError);
    expect(FakeWorker.instances.every((worker) => worker.terminated)).toBe(true);
  });
});
