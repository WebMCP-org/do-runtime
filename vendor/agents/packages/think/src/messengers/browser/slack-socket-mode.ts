/** Alias @slack/socket-mode here when the host forwards native socket events. */
export class SocketModeClient {
  constructor(_options?: { appToken: string }) {
    throw new Error(
      "@slack/socket-mode is unavailable in the browser; use startSlackSocketClient and forwarded socket events"
    );
  }
}
