// Network reachability probe. A single TCP SYN to a host:port — cheaper than an
// HTTP request, needs no auth, and (unlike a bare DNS lookup) can't be fooled by
// a stale mDNS cache: it only succeeds if a route to the host actually exists.
// Used by the scheduler to tell "we're offline" (laptop asleep / Wi-Fi down)
// apart from a real send/fetch failure, so a whole outage logs once instead of
// once per account.

import net from 'node:net';

export type Reachable = () => Promise<boolean>;

export interface ProbeOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
}

/** Returns a probe that resolves true iff a TCP connection to host:port opens. */
export function makeTcpProbe(opts: ProbeOptions = {}): Reachable {
  const host = opts.host ?? 'gmail.googleapis.com';
  const port = opts.port ?? 443;
  const timeoutMs = opts.timeoutMs ?? 3_000;

  return () =>
    new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false)); // ENOTFOUND / ECONNREFUSED / ENETUNREACH
      socket.connect(port, host);
      socket.unref(); // never keep the process alive for a probe
    });
}
