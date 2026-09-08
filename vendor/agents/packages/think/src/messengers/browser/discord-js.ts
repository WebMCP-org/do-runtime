/** Alias discord.js here when the host forwards native Gateway events. */
export class Client {
  constructor(_options?: {
    intents: readonly number[];
    partials: readonly number[];
  }) {
    throw new Error(
      "discord.js is unavailable in the browser; use startDiscordGatewayClient and forwarded Gateway events"
    );
  }
}

export const Events = Object.freeze({});
export const GatewayIntentBits = Object.freeze({});
export const Partials = Object.freeze({});
