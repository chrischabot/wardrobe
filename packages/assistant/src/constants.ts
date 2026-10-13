/** Constants shared by the conversation actor and its client, kept apart so neither imports the other for them. */

/** Why an erased conversation actor retires its instance (see GarderobeAssistantBase.eraseEverything); the client retries past it. */
export const ERASED_REASON = "erased at the owner's request";
