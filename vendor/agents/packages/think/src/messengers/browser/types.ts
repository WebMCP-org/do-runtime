/** The existing Chat SDK forwarded-event body and authentication headers. */
export interface ForwardedMessengerEvent {
  body: string;
  headers: Record<string, string>;
}

export interface MessengerSocketStatus {
  phase: "connecting" | "connected" | "reconnecting" | "auth_failed";
  userName?: string;
  error?: string;
}
