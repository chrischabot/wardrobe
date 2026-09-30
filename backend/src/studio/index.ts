/**
 * Studio backend interface (spec section 3). The API/MCP layer mounts routes over StudioService;
 * the Studio commands are registered in the shared command catalogue.
 */
export { StudioService, DAY_BOUND_RULES, type StudioDeps, type StudioCommandInput, type StudioActionResult } from './service.js';
export { checkSlots, combinationId } from './commands.js';
