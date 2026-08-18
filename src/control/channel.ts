// The ONLY thing control/ knows about transport.
//
// docs/design.md §2 makes this the load-bearing boundary: control/ must not import worker/ (or any
// Copilot-specific module), so the control plane can be exercised end-to-end without a tunnel or a
// subscription, and so swapping the transport later (WebSocket, SSH, a different host) rewrites one
// folder instead of the whole plane. Everything above this interface deals in messages, never sockets.

export type MessageHandler = (msg: unknown) => void;
export type Unsubscribe = () => void;

// One peer-to-peer duplex connection.
export interface Channel {
  send(msg: unknown): void;
  onMessage(handler: MessageHandler): Unsubscribe;
  onClose(handler: () => void): Unsubscribe;
  close(): void;
}

// Hub side: accepts many peers. `deviceId` is whatever the transport authenticated/identified.
export interface Peer extends Channel {
  readonly deviceId: string;
}
export interface ChannelServer {
  onPeer(handler: (peer: Peer) => void): Unsubscribe;
  close(): void;
}

// Deliver to every handler even if one throws.
//
// The hub broadcasts through this path, so an exception from a single dead peer must not abort the
// loop and starve the remaining nodes — the same failure the supervisor's SSE `send` already guards
// against (src/supervisor/api.ts). Errors are swallowed here because the caller (a broadcast loop)
// has no meaningful recovery: the peer's own close handling reaps it.
function fanOut(handlers: Set<MessageHandler>, msg: unknown): void {
  for (const h of [...handlers]) {
    try { h(msg); } catch { /* one bad subscriber must not stop the rest */ }
  }
}

class MemoryChannel implements Channel {
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly closeHandlers = new Set<() => void>();
  private closed = false;
  peer!: MemoryChannel;

  send(msg: unknown): void {
    if (this.closed || this.peer.closed) return; // a send on a dead channel is a no-op, not a throw
    fanOut(this.peer.messageHandlers, msg);
  }
  onMessage(handler: MessageHandler): Unsubscribe {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }
  onClose(handler: () => void): Unsubscribe {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }
  close(): void {
    if (this.closed) return; // idempotent: callers close on both error and normal teardown paths
    this.closed = true;
    for (const h of [...this.closeHandlers]) { try { h(); } catch { /* ignore */ } }
    this.peer.close(); // closing one end tears down the pair, mirroring a real socket
  }
}

// A connected pair with no I/O. This is what makes hub↔agent logic unit-testable with no ports, and
// it is the reference semantics every real transport must match.
export function memoryChannelPair(): [Channel, Channel] {
  const a = new MemoryChannel();
  const b = new MemoryChannel();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
