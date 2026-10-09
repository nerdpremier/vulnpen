/**
 * The two numbers the agent plans against, as the backend defaults them
 * (backend/src/utils/modelMetadata.ts). The live values come from the API — a
 * model can declare its own window and output ceiling in Settings — so these are
 * only the fallbacks for a session the server has not described yet: an older
 * transcript, a stream that dropped the field. They are duplicated here because
 * the browser cannot import the backend, so keep them in step: a gauge drawn
 * against a window the server does not use reads as "plenty of room left" while
 * the agent is in fact summarizing.
 */
export const DEFAULT_CONTEXT_LIMIT = 200_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
