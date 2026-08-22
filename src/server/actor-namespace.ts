import { DurableObjectNamespace, type ActorChannelFactory } from "../api/actor";
import { ActorIdFactoryImpl } from "./actor-id-impl";

/** Assemble the configured namespace binding a host places in `env`. */
export function createDurableObjectNamespace<
  T extends Rpc.DurableObjectBranded | undefined = undefined,
>(uniqueKey: string, channel: ActorChannelFactory): DurableObjectNamespace<T> {
  return new DurableObjectNamespace<T>(channel, new ActorIdFactoryImpl(uniqueKey));
}
