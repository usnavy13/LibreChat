import {
  mergeFileConfig,
  decideFileReading,
  getEndpointFileConfig,
  resolveUseResponsesApi,
  resolveLLMDeliveryPolicy,
  getCustomEndpointProvider,
  isSpeechProviderConfigured,
  resolveTurnLLMDeliveryPath,
  hasInferredLLMDeliveryPath,
} from 'librechat-data-provider';
import type {
  TDefaultLLMDeliveryPath,
  TurnDeliveryRouting,
  TurnDeliveryFile,
  TurnFileConsumers,
} from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { collectModelBoundHistoricalFileIdState } from '~/middleware/modelBoundContent';

/** The app config a turn's attachment routing reads. */
export type TurnDeliveryConfig = Pick<AppConfig, 'fileConfig' | 'speech' | 'endpoints'>;

/** The fields of an agent that route its attachments. */
export interface TurnDeliveryAgent {
  provider: string;
  /** The endpoint name initialization records before it swaps `provider` for the backing
   *  client; an agent loaded without one is routed by its provider. */
  endpoint?: string | null;
  /** The Responses API setting the turn runs on, once initialization has decided it. */
  model_parameters?: { useResponsesApi?: boolean } | null;
}

/**
 * Settles how the agent running a turn receives its attachments.
 *
 * Read once, after initialization has resolved the backing provider and the Responses API
 * decision: the file policy is the one configured under the endpoint's own name, the media
 * dialect is the one its config declares rather than the client family it runs as, and the
 * Responses setting is the one the model call uses. Every reader of a turn route consumes the
 * returned value, so delivery, steering and child run-file encoding cannot answer differently.
 */
export function resolveTurnDeliveryRouting({
  agent,
  config,
}: {
  agent: TurnDeliveryAgent;
  config?: TurnDeliveryConfig;
}): TurnDeliveryRouting {
  const endpoint = agent.endpoint ?? agent.provider;
  const fileConfig = mergeFileConfig(config?.fileConfig);
  return {
    fileConfig,
    endpointConfig: getEndpointFileConfig({ fileConfig, endpoint }),
    endpoint,
    endpointProvider: getCustomEndpointProvider(config?.endpoints?.custom, endpoint),
    useResponsesApi: resolveUseResponsesApi(agent.model_parameters?.useResponsesApi),
    sttConfigured: isSpeechProviderConfigured(config?.speech?.stt),
  };
}

/** The routing an agent's turn delivers by and the tools judged as its readers. */
export interface TurnDeliveryInputs {
  routing?: TurnDeliveryRouting;
  consumers?: TurnFileConsumers;
}

const isAutomaticRouting = (routing?: TurnDeliveryRouting): boolean =>
  resolveLLMDeliveryPolicy(routing?.endpointConfig) === 'automatic';

const withDeliveryPath = <T extends TurnDeliveryFile>(
  file: T,
  llmDeliveryPath: TDefaultLLMDeliveryPath | undefined,
): T =>
  llmDeliveryPath == null || llmDeliveryPath === file.llmDeliveryPath
    ? file
    : { ...file, llmDeliveryPath };

/** Maps each file, returning the input array itself when no file was replaced. */
function mapTurnCopies<T extends TurnDeliveryFile>(files: T[], map: (file: T) => T): T[] {
  let changed = false;
  const result = files.map((file) => {
    const next = map(file);
    changed ||= next !== file;
    return next;
  });
  return changed ? result : files;
}

/** Materialize the exact turn route before admission without mutating stored records. */
export function applyTurnDelivery<T extends TurnDeliveryFile>(
  files: T[],
  { routing, consumers }: TurnDeliveryInputs,
): T[] {
  if (routing == null) {
    return files;
  }
  return mapTurnCopies(files, (file) =>
    hasInferredLLMDeliveryPath(file)
      ? withDeliveryPath(file, resolveTurnLLMDeliveryPath(routing, file, consumers))
      : file,
  );
}

/**
 * The turn copies as classic routing would deliver them, for the full-set content checks.
 *
 * Inspection coverage keys on the text route, so a file the automatic policy hands to a tool
 * instead of the prompt would otherwise lose the text coverage classic routing gives it, and
 * rerouting must not change what is inspected. Returns its input under classic routing and
 * whenever no copy differs; stored records and the input copies are never changed.
 */
export function toClassicInspectionView<T extends TurnDeliveryFile>(
  files: T[],
  routing?: TurnDeliveryRouting,
  consumers?: TurnFileConsumers,
): T[] {
  if (!isAutomaticRouting(routing)) {
    return files;
  }
  return mapTurnCopies(files, (file) => {
    const { automatic, classicPath } = decideFileReading({ routing, file, consumers });
    return automatic ? withDeliveryPath(file, classicPath) : file;
  });
}

/** Charges text a referenced inferred tool file may have been delivered as fallback. */
const chargeRetainedFallbackText = <T extends TurnDeliveryFile>(file: T): T =>
  hasInferredLLMDeliveryPath(file) && file.llmDeliveryPath === 'none' && file.text
    ? { ...file, llmDeliveryPath: 'text' }
    : file;

/**
 * Checkpoints replay already encoded content; current tools and policy cannot remove it.
 * A referenced inferred tool file carrying extracted text may have been delivered as fallback.
 * Charge that text conservatively even if fallback was since disabled. Explicit destinations
 * and records predating routing keep their existing accounting; no stored record is changed.
 *
 * Under the automatic policy a file it reads is charged by the resuming agent's own decision,
 * so text that policy withheld for a tool is not charged; the conservative charge still covers
 * every file the decision leaves on its classic route.
 */
export function applyCheckpointDelivery<T extends TurnDeliveryFile>(
  files: T[],
  { routing, consumers }: TurnDeliveryInputs = {},
): T[] {
  if (!isAutomaticRouting(routing)) {
    return files.map(chargeRetainedFallbackText);
  }
  return files.map((file) => {
    const reading = decideFileReading({ routing, file, consumers });
    return reading.automatic
      ? withDeliveryPath(file, reading.path)
      : chargeRetainedFallbackText(file);
  });
}

/**
 * A primary agent's tool route cannot decide whether a handoff receives text. Keep
 * owner-hydrated candidates until each receiver resolves them, then add only text absent
 * from the shared prompt to its scoped context. The existing scoped-context pipeline owns
 * endpoint filtering, aggregate admission, inspection and extraction for these copies.
 */
export function resolveScopedTurnAttachments<T extends TurnDeliveryFile & { file_id: string }>({
  agents,
  sharedConversationAgentIds,
  resendFiles,
  messages,
  historicalFiles,
  requestAttachments,
  sharedRunAttachmentIds,
  attachmentsByAgentId,
}: {
  agents: readonly {
    agentId: string;
    agent: {
      deliveryRouting?: TurnDeliveryRouting;
      fileConsumers?: TurnFileConsumers;
    };
  }[];
  /** Only the primary/handoff graph shares root conversation files. */
  sharedConversationAgentIds: readonly string[];
  resendFiles?: boolean;
  messages: Parameters<typeof collectModelBoundHistoricalFileIdState>[0];
  historicalFiles?: ReadonlyMap<string, T>;
  requestAttachments: readonly T[];
  sharedRunAttachmentIds: ReadonlySet<string>;
  attachmentsByAgentId?: Map<string, T[]> | Record<string, T[]>;
}): Map<string, T[]> {
  const candidates = new Map<string, T>();
  for (const fileId of collectModelBoundHistoricalFileIdState(resendFiles === false ? [] : messages)
    .fileIds) {
    const file = historicalFiles?.get(fileId);
    if (file && !sharedRunAttachmentIds.has(fileId)) candidates.set(fileId, file);
  }
  for (const file of requestAttachments) {
    if (!sharedRunAttachmentIds.has(file.file_id)) candidates.set(file.file_id, file);
  }
  const sharedAgents = new Set(sharedConversationAgentIds);
  const result = new Map<string, T[]>();
  for (const { agentId, agent } of agents) {
    const scoped =
      attachmentsByAgentId instanceof Map
        ? (attachmentsByAgentId.get(agentId) ?? [])
        : (attachmentsByAgentId?.[agentId] ?? []);
    const files = new Map(scoped.map((file) => [file.file_id, file]));
    for (const [fileId, file] of sharedAgents.has(agentId) ? candidates : []) {
      if (files.has(fileId)) continue;
      const path = resolveTurnLLMDeliveryPath(agent.deliveryRouting, file, agent.fileConsumers);
      if (path === 'text' && file.text) files.set(fileId, { ...file, llmDeliveryPath: path });
    }
    result.set(agentId, [...files.values()]);
  }
  return result;
}
