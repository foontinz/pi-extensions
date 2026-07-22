import type { Extension } from "@earendil-works/pi-coding-agent";

export const PROVIDER_PAYLOAD_TRANSFORMS_SYMBOL = Symbol.for("@pi/provider-payload-transforms/v1");

export interface ProviderPayloadModel {
  provider?: string;
  api?: string;
}

export type ProviderPayloadTransform = (
  payload: unknown,
  model: ProviderPayloadModel | undefined,
) => unknown | undefined | Promise<unknown | undefined>;

type ProviderPayloadTransformRegistry = Map<string, ProviderPayloadTransform>;

export function providerPayloadTransformRegistry(): ProviderPayloadTransformRegistry {
  const root = globalThis as typeof globalThis & {
    [PROVIDER_PAYLOAD_TRANSFORMS_SYMBOL]?: ProviderPayloadTransformRegistry;
  };
  const existing = root[PROVIDER_PAYLOAD_TRANSFORMS_SYMBOL];
  if (existing instanceof Map) return existing;
  const created: ProviderPayloadTransformRegistry = new Map();
  root[PROVIDER_PAYLOAD_TRANSFORMS_SYMBOL] = created;
  return created;
}

/**
 * Nested agents intentionally load no normal extensions: loading workflow or
 * subagent extensions recursively would expose recursive orchestration tools.
 * This bridge carries only explicitly registered provider-payload transforms
 * into child requests, without loading any tools, commands, or lifecycle hooks.
 */
export function createProviderPayloadBridgeExtension(): Extension {
  const path = "<provider-payload-bridge>";
  return {
    path,
    resolvedPath: path,
    sourceInfo: {
      path,
      source: "provider-payload-bridge",
      scope: "temporary",
      origin: "top-level",
    },
    handlers: new Map([
      ["before_provider_request", [async (event: { payload: unknown }, ctx: { model?: ProviderPayloadModel }) => {
        let payload = event.payload;
        for (const transform of providerPayloadTransformRegistry().values()) {
          const next = await transform(payload, ctx.model);
          if (next !== undefined) payload = next;
        }
        return payload === event.payload ? undefined : payload;
      }]],
    ]),
    tools: new Map(),
    messageRenderers: new Map(),
    entryRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  } as Extension;
}
