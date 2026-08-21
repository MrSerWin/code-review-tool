import { EventEmitter } from 'node:events';

// Preview-local bus, mirroring src/events.ts for reviews. The engine
// publishes, the SSE route subscribes.
const bus = new EventEmitter();
bus.setMaxListeners(0);

const topic = (previewId: number) => `preview:${previewId}`;

export function publishPreview(previewId: number, payload: object): void {
  bus.emit(topic(previewId), payload);
}

export function subscribePreview(previewId: number, cb: (payload: object) => void): () => void {
  const t = topic(previewId);
  bus.on(t, cb);
  return () => {
    bus.off(t, cb);
  };
}
