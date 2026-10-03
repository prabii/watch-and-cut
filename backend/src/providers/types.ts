export interface PlanRequest {
  provider: string
  model: string
  system: string
  user: string
  images: string[] // base64 JPEG, no data: prefix
}

/** Per-request overrides sent by the browser ("bring your own key"). Never logged. */
export interface Credentials {
  apiKey?: string
  baseUrl?: string
  /** Claude: for API keys that aren't scoped to a workspace. */
  workspaceId?: string
}

export interface ModelReply {
  text: string
  model: string
}

export interface ModelInfo {
  id: string
  label: string
  detail?: string
}

export interface ProviderInfo {
  id: string
  label: string
  kind: 'cloud' | 'local'
  /** A key is configured on the server, so the user doesn't need to bring one. */
  serverKey: boolean
  needsKey: boolean
  customBaseUrl: boolean
  defaultModel: string
  models: ModelInfo[]
  available: boolean
  note?: string
}

export interface Provider {
  info(): Promise<ProviderInfo>
  plan(req: PlanRequest, creds: Credentials): Promise<ModelReply>
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message)
  }
}
