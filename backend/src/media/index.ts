export { MediaService, resizeSvg, THUMBNAIL_WIDTHS, type MediaServiceDeps, type IngestInput, type RejectInput, type ReceiveResult, type ImageTransformer, type ThumbnailWidth } from './service.js';
export { MediaPipeline, handleMediaQueue, createMediaPipeline, normalizeSvgCanvas, DISCOVERY_ALLOWANCE, type MediaPipelineDeps, type MediaQueueMessage, type QueueLike, type JobOutcome } from './pipeline.js';
export { signToken, verifyToken, mediaSigningKey, LOCAL_DEV_SIGNING_KEY, type TokenClaims, type TokenPurpose } from './signing.js';
export { checkFidelity, matchCandidate, rankCandidates, photoRequest, deltaE, colourWords, FIDELITY_VERSION, MAX_COLOUR_DELTA_E, MIN_CATALOGUE_SIDE, type CandidateDecision } from './fidelity.js';
export { sniff, validateRaster, stripLocationMetadata, sha256Bytes } from './sniff.js';
export { checkTrustedSvg, escapeXml } from './svg.js';
export { selectCatalogue, defaultLabel, FAITHFUL_CLASSES, COMPOSABLE_CLASSES } from './records.js';
export type * from './providers.js';
export * as fakes from './fakes.js';
