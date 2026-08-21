import net from 'node:net';
import { config } from '../config.js';
import { portsInUse } from './store.js';

/**
 * Ports held by an allocation that has not been recorded in the database yet.
 * Without this, two previews started in the same tick would race for the same
 * port: the database cannot know about a reservation that is not committed.
 */
const reserved = new Set<number>();

export interface PortReservation {
  ports: Record<string, number>;
  /** Frees the listening sockets so the preview's own processes can bind them. */
  release(): void;
}

/** Binds the port for real: the database can only say which ports we handed out. */
function tryBind(port: number): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    const fail = (): void => {
      server.removeAllListeners();
      server.close();
      resolve(null);
    };
    server.once('error', fail);
    server.listen({ port, host: '0.0.0.0', exclusive: true }, () => {
      server.removeAllListeners('error');
      resolve(server);
    });
  });
}

/**
 * Allocates one free host port per logical id. The sockets stay open until
 * `release()` so nothing else can take a port between allocation and the
 * moment the preview row records it.
 */
export async function allocatePorts(ids: readonly string[]): Promise<PortReservation> {
  const { from, to } = config.previewPortRange;
  const taken = portsInUse();
  const held: net.Server[] = [];
  const claimed: number[] = [];
  const ports: Record<string, number> = {};

  const release = (): void => {
    for (const port of claimed) reserved.delete(port);
    claimed.length = 0;
    for (const server of held.splice(0)) server.close();
  };

  try {
    let candidate = from;
    for (const id of ids) {
      let allocated: number | null = null;
      while (candidate <= to) {
        const port = candidate;
        candidate += 1;
        if (taken.has(port) || reserved.has(port)) continue;
        const server = await tryBind(port);
        if (!server) continue;
        held.push(server);
        reserved.add(port);
        claimed.push(port);
        allocated = port;
        break;
      }
      if (allocated === null) {
        throw new Error(
          `No free host port left in PREVIEW_PORT_RANGE ${from}-${to} for "${id}". ` +
            'Stop an old preview or widen the range.',
        );
      }
      ports[id] = allocated;
    }
  } catch (err) {
    release();
    throw err;
  }

  return { ports, release };
}
