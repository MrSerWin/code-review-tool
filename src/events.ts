import { EventEmitter } from 'node:events';

// Process-level bus. The queue/runner publishes, the SSE route subscribes.
const bus = new EventEmitter();
bus.setMaxListeners(0);

const topic = (reviewId: number) => `review:${reviewId}`;

export function publish(reviewId: number, payload: object): void {
  bus.emit(topic(reviewId), payload);
}

export function subscribe(reviewId: number, cb: (payload: object) => void): () => void {
  const t = topic(reviewId);
  bus.on(t, cb);
  return () => {
    bus.off(t, cb);
  };
}
