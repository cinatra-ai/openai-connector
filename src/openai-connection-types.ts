// Connection types owned by the openai connector (decoupled from `@/lib/types`).
//
// The host `@/lib/openai-connection-store` persists/returns this shape; the
// connector cannot import the host type without re-anchoring to `src/`, so the
// contract is duplicated here. Keep in sync with the host store's
// `OpenAIConnection` shape — the injected deps are typed against THIS.

export type OpenAIServiceTier = "default" | "flex" | "priority";

export type OpenAIConnection = {
  apiKey?: string;
  projectId?: string;
  organizationId?: string;
  defaultModel?: string;
  serviceTier?: OpenAIServiceTier;
  loggingEnabled?: boolean;
  promptCachingEnabled?: boolean;
  lastValidatedAt?: string;
  availableModels?: string[];
};

/** Input to `updateOpenAIConnection` (no derived `lastValidatedAt`). */
export type OpenAIConnectionUpdate = {
  apiKey?: string;
  projectId?: string;
  organizationId?: string;
  defaultModel?: string;
  serviceTier?: OpenAIServiceTier;
  loggingEnabled?: boolean;
  promptCachingEnabled?: boolean;
  availableModels?: string[];
};
