import { Providers } from '@librechat/agents';
import { logger } from '@librechat/data-schemas';
import {
  EToolResources,
  isBedrockDocumentType,
  categorizeForReading,
  canToolResourceConsume,
  isAnthropicDocumentType,
  resolveLLMDeliveryPolicy,
  isAutomaticReadingRecord,
  isDocumentSupportedProvider,
} from 'librechat-data-provider';
import type {
  TFile,
  TextDerivation,
  ReadingEvidence,
  TurnDeliveryFile,
  TurnReadingInputs,
  TLLMDeliveryPolicy,
  TurnDeliveryRouting,
} from 'librechat-data-provider';
import type { DocumentRejection } from '~/types';
import { usesAnthropicDocumentCapabilities } from '~/files/encode/document';
import { getNativeDocumentSizeLimit } from '~/files/validation';
import { getSafeErrorMetadata } from '~/utils/errors';

/** Where a record's retained original is stored, for the deriver that reads it back. */
type StoredOriginal = Partial<Pick<TFile, 'filename' | 'filepath' | 'storageKey'>>;

/** A turn copy of an attachment record, identified so request-scoped evidence can name it. */
export type TurnReadingFile = TurnDeliveryFile & StoredOriginal & { file_id: string };

/** Why no text was derived on this request; none of these is persisted, so a later turn retries. */
export type DerivationSkipReason = 'policy' | 'storage_unavailable' | 'aborted' | 'no_extractor';

/**
 * The outcome of deriving a file's text from its retained original. A `failed` outcome is
 * deterministic, and `persist` says whether the record may keep it as a failed marker.
 */
export type DerivedText =
  | { status: 'derived'; text: string; textDerivation: TextDerivation }
  | { status: 'failed'; textDerivation: TextDerivation; persist: boolean }
  | { status: 'skipped'; reason: DerivationSkipReason };

export type FileTextDeriver = (file: TurnReadingFile, signal?: AbortSignal) => Promise<DerivedText>;

/** Which files File Search will receive on this turn, known once tools have loaded. */
export interface SearchEvidence {
  /** Files queued for embedding on this request. */
  queued: readonly string[];
  /** Files registered under the turn's `file_search` tool resource. */
  registered: readonly string[];
}

/** Request-scoped counts for the turn's reading diagnostics. */
export interface TurnReadingStats {
  overflow: number;
  rejected: number;
  textFailed: number;
  derived: number;
  dropped: number;
}

/**
 * One agent's reading evidence for one request. Attached as `deliveryRouting.reading`, so every
 * reader holding the routing sees the verdicts and request-scoped evidence the others recorded.
 */
export interface TurnReadingContext extends TurnReadingInputs {
  readonly policy: TLLMDeliveryPolicy;
  /** The token count of the file's current text, when judging it required a count. */
  knownTokenCount(file: TurnDeliveryFile): number | undefined;
  addOverflow(fileIds: Iterable<string>): void;
  recordRejections(rejections: ReadonlyArray<DocumentRejection>): void;
  markTextFailed(fileId: string): void;
  setSearchEvidence(evidence: SearchEvidence): void;
  /** Request attachments the endpoint's runtime policy removed before delivery. */
  recordDropped(files: Iterable<TurnReadingFile>): void;
  dropped(): readonly TurnReadingFile[];
  /** Derives the file's text once per request; repeated calls share the first derivation. */
  derive(file: TurnReadingFile, signal?: AbortSignal): Promise<DerivedText>;
  /** Settles the request's pending reading work. */
  flush(): Promise<void>;
  stats(): TurnReadingStats;
}

export interface BuildTurnReadingContextParams {
  routing: TurnDeliveryRouting;
  /** The provider the document encoder receives for this agent. */
  provider: string;
  model?: string;
  /** The request's `fileTokenLimit`; a missing or zero limit delivers no text. */
  fileTokenLimit: number | undefined;
  /** The endpoint `fileSizeLimit` the document encoder applies, in bytes. */
  configuredFileSizeLimit: number | undefined;
  /** A synchronous token count, ready for use. */
  countTokens: (text: string) => number;
  deriveText?: FileTextDeriver;
  signal?: AbortSignal;
}

type NativeVerdict = NonNullable<ReadingEvidence['native']>;

interface TextVerdict {
  fit: NonNullable<ReadingEvidence['text']>;
  tokens?: number;
}

const TURN_READING = Symbol('turnReading');

type BrandedTurnReadingContext = TurnReadingContext & { readonly [TURN_READING]: true };

const isTurnReadingContext = (
  reading: TurnReadingInputs | undefined,
): reading is BrandedTurnReadingContext => reading != null && TURN_READING in reading;

/** The reading context {@link buildTurnReadingContext} built for this routing, if any. */
export function getTurnReadingContext(
  routing?: Pick<TurnDeliveryRouting, 'reading'> | null,
): TurnReadingContext | undefined {
  const reading = routing?.reading;
  return isTurnReadingContext(reading) ? reading : undefined;
}

/** The `extractFileContext` options a turn's reading supplies for its text injection. */
export interface TurnTextOptions {
  knownTokenCount?: (file: TurnDeliveryFile) => number | undefined;
  markTruncation?: boolean;
}

/**
 * Reuses the token counts the reading judged text fit with, and under the automatic policy makes
 * any truncation visible: the policy never sends partial text on purpose, so a truncated file
 * means a reader judged it without the turn's evidence. Empty without a reading context.
 */
export function getTurnTextOptions(
  routing?: Pick<TurnDeliveryRouting, 'reading'> | null,
): TurnTextOptions {
  const context = getTurnReadingContext(routing);
  if (context == null) {
    return {};
  }
  return {
    knownTokenCount: context.knownTokenCount,
    markTruncation: context.policy === 'automatic',
  };
}

const hasText = (text: TurnDeliveryFile['text']): text is string =>
  typeof text === 'string' && text.length > 0;

/** Whether the document encoder emits any block for this type on this provider and model. */
function encoderEmits(provider: string, mimeType: string, model?: string): boolean {
  if (provider === Providers.BEDROCK) {
    return isBedrockDocumentType(mimeType);
  }
  if (!isDocumentSupportedProvider(provider)) {
    return false;
  }
  return (
    !usesAnthropicDocumentCapabilities(provider as Providers, model) ||
    isAnthropicDocumentType(mimeType)
  );
}

/**
 * Text fits when the complete text is within the token limit. Every token spans at least one
 * byte, so a byte length within the limit settles it without counting.
 */
function judgeTextFit(
  text: string,
  limit: number | undefined,
  countTokens: (text: string) => number,
): TextVerdict {
  if (!limit) {
    return { fit: 'exceeds' };
  }
  if (Buffer.byteLength(text) <= limit) {
    return { fit: 'fits' };
  }
  const tokens = countTokens(text);
  return { fit: tokens <= limit ? 'fits' : 'exceeds', tokens };
}

function createTurnReadingContext(
  policy: TLLMDeliveryPolicy,
  {
    routing,
    provider,
    model,
    fileTokenLimit,
    configuredFileSizeLimit,
    countTokens,
    deriveText,
    signal: requestSignal,
  }: BuildTurnReadingContextParams,
): BrandedTurnReadingContext {
  const automatic = policy === 'automatic';
  const nativeVerdicts = new Map<string, NativeVerdict | null>();
  const textVerdicts = new Map<string, TextVerdict>();
  const overflow = new Set<string>();
  const rejected = new Map<string, DocumentRejection['reason']>();
  const textFailed = new Set<string>();
  const droppedFiles = new Map<string, TurnReadingFile>();
  const derivations = new Map<string, Promise<DerivedText>>();
  const pending = new Set<Promise<DerivedText>>();
  let searchFileIds: ReadonlySet<string> | undefined;
  let derived = 0;

  const judgeNativeUncached = (file: TurnDeliveryFile): NativeVerdict | null => {
    const routingMimeType = file.metadata?.routingMimeType ?? file.type ?? '';
    if (categorizeForReading(routingMimeType) === 'media') {
      return null;
    }
    const mimeType = file.type ?? '';
    if (!encoderEmits(provider, mimeType, model)) {
      return 'unsupported';
    }
    const limit = getNativeDocumentSizeLimit({
      provider,
      mimeType,
      model,
      configuredFileSizeLimit,
    });
    return limit !== undefined && (file.bytes ?? 0) > limit ? 'capacity' : 'fits';
  };

  const judgeNative = (file: TurnDeliveryFile): NativeVerdict | null => {
    if (file.file_id == null) {
      return judgeNativeUncached(file);
    }
    const cached = nativeVerdicts.get(file.file_id);
    if (cached !== undefined) {
      return cached;
    }
    const verdict = judgeNativeUncached(file);
    nativeVerdicts.set(file.file_id, verdict);
    return verdict;
  };

  const textKey = (file: TurnDeliveryFile, text: string): string | undefined =>
    file.file_id == null ? undefined : `${file.file_id}:${text.length}`;

  const judgeText = (file: TurnDeliveryFile): TextVerdict | undefined => {
    if (!hasText(file.text)) {
      return undefined;
    }
    const key = textKey(file, file.text);
    const cached = key == null ? undefined : textVerdicts.get(key);
    if (cached != null) {
      return cached;
    }
    const verdict = judgeTextFit(file.text, fileTokenLimit, countTokens);
    if (key != null) {
      textVerdicts.set(key, verdict);
    }
    return verdict;
  };

  const judgeSearch = (file: TurnDeliveryFile): ReadingEvidence['search'] => {
    if (searchFileIds == null) {
      return undefined;
    }
    const unreachable =
      (file.file_id == null || !searchFileIds.has(file.file_id)) &&
      canToolResourceConsume(EToolResources.file_search, file.type ?? '') &&
      isAutomaticReadingRecord(routing, file);
    return unreachable ? 'unreachable' : 'reachable';
  };

  const requestEvidence = (fileId: string | undefined): ReadingEvidence => ({
    ...(fileId != null && textFailed.has(fileId) && { textFailed: true as const }),
  });

  const judge = (file: TurnDeliveryFile): ReadingEvidence => {
    if (!automatic) {
      return requestEvidence(file.file_id);
    }
    const fileId = file.file_id;
    const native = judgeNative(file);
    const text = judgeText(file);
    const rejection = fileId == null ? undefined : rejected.get(fileId);
    const search = judgeSearch(file);
    return {
      ...(native != null && { native }),
      ...(text != null && { text: text.fit }),
      ...(rejection != null && { rejected: rejection }),
      ...(fileId != null && overflow.has(fileId) && { overflow: true as const }),
      ...requestEvidence(fileId),
      ...(search != null && { search }),
    };
  };

  const knownTokenCount = (file: TurnDeliveryFile): number | undefined => {
    if (!hasText(file.text)) {
      return undefined;
    }
    const key = textKey(file, file.text);
    return key == null ? undefined : textVerdicts.get(key)?.tokens;
  };

  const runDerivation = (file: TurnReadingFile, signal?: AbortSignal): Promise<DerivedText> => {
    if (deriveText == null) {
      return Promise.resolve({ status: 'skipped', reason: 'no_extractor' });
    }
    return deriveText(file, signal).then(
      (result): DerivedText => {
        if (result.status === 'derived') {
          derived += 1;
        }
        return result;
      },
      (error: unknown): DerivedText => {
        logger.error(
          `[readingText] file_id=${file.file_id} outcome=skipped reason=derivation_error`,
          getSafeErrorMetadata(error),
        );
        return { status: 'skipped', reason: signal?.aborted ? 'aborted' : 'storage_unavailable' };
      },
    );
  };

  const derive = (file: TurnReadingFile, signal?: AbortSignal): Promise<DerivedText> => {
    const existing = derivations.get(file.file_id);
    if (existing != null) {
      return existing;
    }
    const derivation = runDerivation(file, signal ?? requestSignal);
    derivations.set(file.file_id, derivation);
    pending.add(derivation);
    return derivation;
  };

  const flush = async (): Promise<void> => {
    const settling = [...pending];
    pending.clear();
    await Promise.allSettled(settling);
  };

  return {
    [TURN_READING]: true,
    policy,
    canDerive: deriveText != null,
    judge,
    knownTokenCount,
    addOverflow: (fileIds) => {
      for (const fileId of fileIds) {
        overflow.add(fileId);
      }
    },
    recordRejections: (rejections) => {
      for (const { file_id, reason } of rejections) {
        if (!rejected.has(file_id)) {
          rejected.set(file_id, reason);
        }
      }
    },
    markTextFailed: (fileId) => {
      textFailed.add(fileId);
    },
    setSearchEvidence: ({ queued, registered }) => {
      searchFileIds = new Set([...queued, ...registered]);
    },
    recordDropped: (files) => {
      for (const file of files) {
        if (!droppedFiles.has(file.file_id)) {
          droppedFiles.set(file.file_id, file);
        }
      }
    },
    dropped: () => [...droppedFiles.values()],
    derive,
    flush,
    stats: () => ({
      overflow: overflow.size,
      rejected: rejected.size,
      textFailed: textFailed.size,
      derived,
      dropped: droppedFiles.size,
    }),
  };
}

/**
 * Builds the reading evidence for one agent's turn, or nothing where the turn needs none: under
 * the classic policy without a text deriver every route stays classic. Under classic with a
 * deriver the context only derives text, for records the automatic policy marked, and its judge
 * reports nothing but this request's derivation failures.
 */
export function buildTurnReadingContext(
  params: BuildTurnReadingContextParams,
): TurnReadingContext | undefined {
  const policy = resolveLLMDeliveryPolicy(params.routing.endpointConfig);
  if (policy !== 'automatic' && params.deriveText == null) {
    return undefined;
  }
  return createTurnReadingContext(policy, params);
}
