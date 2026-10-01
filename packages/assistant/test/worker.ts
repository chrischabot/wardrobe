/** Worker entry for this package's tests: mounts the conversation actor with the FAKE MODEL boundary. */
export { TestAssistant } from "../src/testing/index.ts";

export default {
  async fetch(): Promise<Response> {
    return new Response("assistant test worker");
  },
};
