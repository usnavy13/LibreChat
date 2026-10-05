import { fileConfig, isTextOnlyRecord } from 'librechat-data-provider';
import type {
  SkipReason,
  FileReading,
  ReadingReason,
  TextDerivation,
  ReadingEvidence,
  EndpointFileConfig,
  TFileReadingNotice,
} from 'librechat-data-provider';
import type { CodeFileState, InventoryEntry, ReadingAgent } from './inventory';
import type { RequestFile, TransmittedFile } from '~/utils/message';
import type { TurnReadingContext, TurnReadingFile } from './turn';
import { collectInventoryEntries } from './inventory';
import { buildMessageFiles } from '~/utils/message';
import { getTurnReadingContext } from './turn';

/** What a notice can say limited the reading, in the user's terms. */
export type ReadingLimitation = NonNullable<TFileReadingNotice['limitation']>;

/** A message file carrying how its message's turn read it. */
export type NoticedFile<T extends TurnReadingFile = TurnReadingFile> = T & {
  reading: TFileReadingNotice;
};

type ReadEntry = Extract<InventoryEntry, { kind: 'read' }>;

/** A request file ref as the client sends it, which may echo the notice an earlier turn saved. */
export type ReplayedFile = RequestFile & { reading?: TFileReadingNotice };

/** What a cause tells the user when a reader took the file anyway, and when nothing did. */
interface LimitationRow {
  read?: ReadingLimitation;
  unread?: ReadingLimitation;
}

/**
 * Every skip a reading can report, so a new reason fails the compile here instead of reaching
 * the user without a notice. A limit the file hit is worth telling whichever reader took it;
 * a missing reader only explains a file nothing read.
 */
const SKIP_LIMITATIONS = {
  code_unavailable: { read: 'code_unavailable', unread: 'code_unavailable' },
  native_capacity: { read: 'too_large_direct', unread: 'too_large_direct' },
  text_exceeds: { read: 'text_too_long', unread: 'text_too_long' },
  aggregate_overflow: { read: 'too_large_together', unread: 'too_large_together' },
  native_unsupported: { unread: 'no_reader' },
  native_rejected: { unread: 'no_reader' },
  text_unavailable: { unread: 'no_reader' },
  search_unavailable: { unread: 'no_reader' },
  no_reader: { unread: 'no_reader' },
} as const satisfies Record<SkipReason | 'no_reader', LimitationRow>;

const REASON_LIMITATIONS: Readonly<Partial<Record<ReadingReason, LimitationRow>>> =
  SKIP_LIMITATIONS;

/** An encode-time rejection names the size when the file was too large to send; a file that
 *  could not be opened says so only when nothing else read it. */
const REJECTION_LIMITATIONS = {
  capacity: { read: 'too_large_direct', unread: 'too_large_direct' },
  integrity: { unread: 'not_prepared' },
  unsupported: { unread: 'no_reader' },
} as const satisfies Record<NonNullable<ReadingEvidence['rejected']>, LimitationRow>;

/** Why this one file's text could not be derived: the type stays readable either way. */
const DERIVATION_LIMITATIONS = {
  parser: 'not_prepared',
  empty: 'not_prepared',
  too_large: 'text_too_long',
  expansion_limit: 'text_too_long',
  original_missing: 'original_missing',
  no_extractor: 'no_reader',
  extractor_unavailable: 'no_reader',
} as const satisfies Record<NonNullable<TextDerivation['reason']>, ReadingLimitation>;

const isCodeReady = (code?: CodeFileState): boolean =>
  code != null && code.state !== 'not_prepared';

const isOriginalMissing = ({ metadata }: TurnReadingFile): boolean =>
  metadata?.textDerivation?.outcome === 'failed' &&
  metadata.textDerivation.reason === 'original_missing';

/** A spreadsheet nothing read is best explained by the analysis it could not get. */
const isUnreadSpreadsheet = (reading: FileReading): boolean =>
  reading.category === 'tabular' &&
  reading.skipped.some(({ reason }) => reason === 'code_unavailable');

/**
 * The reader the user is told about. A code reader counts only once Run Code can open the file;
 * a provider reading the encoder withheld becomes Run Code where it can still open the file.
 */
function selectNoticeReader({ reading, code, withheld }: ReadEntry): TFileReadingNotice['reader'] {
  if (withheld != null) {
    return isCodeReady(code) ? 'code' : 'unavailable';
  }
  if (reading.reader === 'unresolved') {
    return 'unavailable';
  }
  if (reading.reader === 'code' && !isCodeReady(code)) {
    return 'unavailable';
  }
  return reading.reader;
}

/** Why text was not available for an unread file, when this file's derivation explains it. */
function selectTextLimitation(
  file: TurnReadingFile,
  evidence: ReadingEvidence,
): ReadingLimitation | undefined {
  const derivation = file.metadata?.textDerivation;
  if (derivation?.outcome === 'failed' && derivation.reason != null) {
    return DERIVATION_LIMITATIONS[derivation.reason];
  }
  return evidence.textFailed === true ? 'not_prepared' : undefined;
}

function selectLimitation(
  entry: ReadEntry,
  reader: TFileReadingNotice['reader'],
  context: TurnReadingContext,
): ReadingLimitation | undefined {
  const { file, reading, withheld } = entry;
  const unread = reader === 'unavailable';
  if (unread && reading.reader === 'code') {
    return 'not_prepared';
  }
  const evidence = context.judge(file);
  if (reader === 'text' && !reading.automatic && evidence.text === 'exceeds') {
    return 'text_truncated';
  }
  if (reading.code === 'text_only_record') {
    return 'text_only';
  }
  if (unread && isOriginalMissing(file)) {
    return 'original_missing';
  }
  if (unread && isUnreadSpreadsheet(reading)) {
    return 'code_unavailable';
  }
  const reason = withheld ?? reading.reason;
  const rejection =
    reason === 'native_rejected' && evidence.rejected != null
      ? REJECTION_LIMITATIONS[evidence.rejected]
      : undefined;
  const row: LimitationRow = rejection ?? REASON_LIMITATIONS[reason] ?? {};
  if (!unread) {
    return row.read;
  }
  const text = reason === 'text_unavailable' ? selectTextLimitation(file, evidence) : undefined;
  return text ?? row.unread;
}

function describeReading(entry: ReadEntry, context: TurnReadingContext): TFileReadingNotice {
  const reader = selectNoticeReader(entry);
  const limitation = selectLimitation(entry, reader, context);
  return limitation == null ? { reader } : { reader, limitation };
}

/**
 * Why the endpoint's runtime policy refused a request file, mirroring
 * `filterFilesByEndpointRuntimeConfig`: a refused type is not allowed whatever its size, and a
 * permitted type was refused only by the per-file size limit.
 */
function selectDroppedLimitation(
  file: TurnReadingFile,
  endpointConfig: EndpointFileConfig | undefined,
): ReadingLimitation {
  const { disabled, fileSizeLimit, supportedMimeTypes } = endpointConfig ?? {};
  const mimeType = file.metadata?.routingMimeType ?? file.type ?? '';
  const typeAllowed =
    isTextOnlyRecord(file) ||
    supportedMimeTypes == null ||
    supportedMimeTypes.length === 0 ||
    fileConfig.checkType(mimeType, supportedMimeTypes);
  const oversized = fileSizeLimit != null && fileSizeLimit > 0 && (file.bytes ?? 0) > fileSizeLimit;
  return disabled !== true && typeAllowed && oversized ? 'too_large_direct' : 'not_allowed';
}

/**
 * Projects how the automatic policy read each of the request's attachments onto copies for
 * `message.files`, and appends the request files the endpoint refused, so none disappears from
 * the user's message. Under the classic policy the input is returned as is. Notices come from
 * the same entries as the model's inventory, cover only the current request's files, and are
 * never written to stored records or fed back into the turn.
 */
export function withReadingNotices<T extends TurnReadingFile>(
  attachments: T[] | undefined,
  agent: ReadingAgent | null | undefined,
): Array<T | NoticedFile> {
  const files = attachments ?? [];
  const context = getTurnReadingContext(agent?.deliveryRouting);
  if (agent == null || context?.policy !== 'automatic') {
    return files;
  }
  const requestFileIds = new Set(
    (agent.currentRequestAttachments ?? []).map(({ file_id }) => file_id),
  );
  const attachedIds = new Set(files.map(({ file_id }) => file_id));
  const notices = new Map<string, TFileReadingNotice>();
  const dropped: NoticedFile[] = [];
  for (const entry of collectInventoryEntries(agent)) {
    const fileId = entry.file.file_id;
    if (entry.kind === 'read' && requestFileIds.has(fileId)) {
      notices.set(fileId, describeReading(entry, context));
    } else if (entry.kind === 'dropped' && !attachedIds.has(fileId)) {
      const limitation = selectDroppedLimitation(entry.file, agent.deliveryRouting?.endpointConfig);
      dropped.push({ ...entry.file, reading: { reader: 'unavailable', limitation } });
    }
  }
  if (notices.size === 0 && dropped.length === 0) {
    return files;
  }
  const noticed = files.map((file): T | NoticedFile<T> => {
    const reading = notices.get(file.file_id);
    return reading == null ? file : { ...file, reading };
  });
  return [...noticed, ...dropped];
}

/**
 * The user message's `files`: the request's attachments, sanitized for transmission, with how
 * the turn read each one. Every path that saves the user message builds its files here, so no
 * path can drop the notices.
 */
export function buildUserMessageFiles<T extends TurnReadingFile>(
  requestFiles: RequestFile[],
  attachments: T[],
  agent: ReadingAgent | null | undefined,
): Array<TransmittedFile<T | NoticedFile>> {
  return buildMessageFiles(requestFiles, withReadingNotices(attachments, agent));
}

/** Whether a client-sent ref carries a notice; tolerates the malformed entries a body can hold. */
const carriesNotice = (file: ReplayedFile | null | undefined): boolean =>
  file != null && typeof file === 'object' && 'reading' in file;

/**
 * Request file refs without the notices a replayed message carries. A notice is projected by the
 * server for the turn that read the file, so a ref the client sends back (an edit, a resubmission)
 * must not echo the previous turn's notice onto the new message. Returns the input as is when it
 * is not an array (a body without files) or when no ref carries a notice.
 */
export function stripReadingNotices<T extends ReplayedFile>(files: T[]): Array<Omit<T, 'reading'>>;
export function stripReadingNotices<T extends ReplayedFile>(
  files: T[] | undefined,
): Array<Omit<T, 'reading'>> | undefined;
export function stripReadingNotices<T extends ReplayedFile>(
  files: T[] | undefined,
): Array<Omit<T, 'reading'>> | undefined {
  if (!Array.isArray(files) || !files.some(carriesNotice)) {
    return files;
  }
  return files.map((file) => {
    if (!carriesNotice(file)) {
      return file;
    }
    const { reading: _reading, ...ref } = file;
    return ref;
  });
}

/**
 * The user message files a resumed turn's final event carries. Under the classic policy the
 * request refs are carried as is, as they were before notices existed. Under the automatic
 * policy, files restored from the saved user row already carry the notices the paused turn saved;
 * otherwise they are built from the rebuilt client's attachments, as {@link buildUserMessageFiles}
 * built them for the save. The request refs are kept when no attachment matches, so the event
 * never blanks the user's attachments.
 */
export function buildResumedUserMessageFiles<T extends TurnReadingFile>(
  requestFiles: ReplayedFile[],
  attachments: T[] | undefined,
  agent: ReadingAgent | null | undefined,
): Array<ReplayedFile | TransmittedFile<T | NoticedFile>> {
  if (
    !Array.isArray(attachments) ||
    getTurnReadingContext(agent?.deliveryRouting)?.policy !== 'automatic' ||
    requestFiles.some(carriesNotice)
  ) {
    return requestFiles;
  }
  const files = buildUserMessageFiles(requestFiles, attachments, agent);
  return files.length > 0 ? files : requestFiles;
}
