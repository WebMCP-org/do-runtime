import type { ActorContainer } from "@mcp-b/do-runtime";

const BODY_CONSUMERS = ["arrayBuffer", "blob", "bytes", "formData", "json", "text"] as const;

/**
 * Re-enter the actor gate after a host-provided request body promise settles.
 * The runtime gates outbound response bodies internally, but its equivalent
 * inbound helper needs an IoContext and is not exported, so browser hosts own this proxy.
 */
export function gateRequestBody(container: ActorContainer, request: Request): Request {
  return new Proxy(request, {
    get(subject, property): unknown {
      if ((BODY_CONSUMERS as readonly (string | symbol)[]).includes(property)) {
        return (...args: unknown[]): Promise<unknown> =>
          container.awaitIo(
            (subject[property as (typeof BODY_CONSUMERS)[number]] as (
              ...a: unknown[]
            ) => Promise<unknown>).apply(subject, args),
          );
      }
      const value: unknown = Reflect.get(subject, property, subject);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(subject)
        : value;
    },
  });
}
