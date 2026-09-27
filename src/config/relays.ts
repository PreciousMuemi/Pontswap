// Default relay set for the Pontmore swap app.
//
// The relay network is the only database this app has. These are the relays
// every read and write fans out to. A dead relay must never block the others
// (see relay.ts), so this list can include hosts that are occasionally down.

export const DEFAULT_RELAYS: readonly string[] = [
  "ws://localhost:7777", // TEMP e2e
];
