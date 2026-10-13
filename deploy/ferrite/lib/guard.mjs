/**
 * The guard every remote-writing command passes first. A Ferrite deploy, a secret change or a teardown runs only
 * when ALL of these hold, otherwise it is refused before the CLI is called:
 *
 * - the app is the one in ferrite/ferrite.json, and its name is exactly `wardrobe` (this project's app);
 * - the person named the exact target with `--confirm=<account>/<app>`;
 * - `ferrite account` reports that same account as signed in (so a credential for another account never writes).
 */
export const APP_NAME = "wardrobe";

export class GuardRefusal extends Error {}

/** The `--confirm=` value from argv, or null. */
export function confirmation(argv) {
  const arg = argv.find((a) => a.startsWith("--confirm="));
  return arg ? arg.slice("--confirm=".length) : null;
}

/** Throws GuardRefusal unless the target is this project's app in the signed-in account, confirmed by name. */
export function assertTarget({ appName, account, argv }) {
  if (typeof appName !== "string" || appName !== APP_NAME) throw new GuardRefusal(`refused: the app in ferrite/ferrite.json is ${JSON.stringify(appName)}, not this project's wardrobe app`);
  if (account.state !== "signed_in") throw new GuardRefusal(`refused: no signed-in Ferrite account (${account.reason})`);
  const want = `${account.account}/${appName}`;
  const given = confirmation(argv);
  if (given !== want) throw new GuardRefusal(`refused: confirm the exact target with --confirm=${want}${given ? ` (given: ${given})` : ""}`);
  return want;
}
