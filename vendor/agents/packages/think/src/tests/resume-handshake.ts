const MSG_STREAM_RESUMING = "cf_agent_stream_resuming";
const MSG_STREAM_RESUME_ACK = "cf_agent_stream_resume_ack";

/**
 * A connection-less continuation reaches a connected client through the same
 * resume handshake a reconnecting one uses: the server offers
 * `cf_agent_stream_resuming` and streams only once the client acks that id.
 * Test sockets answer it automatically so suites can drive continuations
 * without each re-implementing the handshake.
 */
export function acknowledgeStreamResume(ws: WebSocket): void {
  const acknowledged = new Set<string>();
  ws.addEventListener("message", (event: MessageEvent) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(event.data as string) as Record<string, unknown>;
    } catch {
      return;
    }
    if (
      frame.type === MSG_STREAM_RESUMING &&
      typeof frame.id === "string" &&
      !acknowledged.has(frame.id)
    ) {
      acknowledged.add(frame.id);
      ws.send(JSON.stringify({ type: MSG_STREAM_RESUME_ACK, id: frame.id }));
    }
  });
}
