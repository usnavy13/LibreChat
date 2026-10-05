import { useCallback } from 'react';
import type { TFile, TFileReadingNotice } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';

type Reader = TFileReadingNotice['reader'];
type Limitation = NonNullable<TFileReadingNotice['limitation']>;

/** How a message file was read: the chip's subtitle and its accessible name. */
export interface ReadingCaption {
  text: string;
  label: string;
}

/**
 * Maps rather than records: a newer server can send a value this client has no words for, and
 * a record lookup would also answer for inherited keys such as `constructor`.
 */
const READER_KEYS: ReadonlyMap<string, TranslationKeys> = new Map(
  Object.entries({
    provider: 'com_ui_file_reading_provider',
    text: 'com_ui_file_reading_text',
    search: 'com_ui_file_reading_search',
    code: 'com_ui_file_reading_code',
    unavailable: 'com_ui_file_reading_unavailable',
  } satisfies Record<Reader, TranslationKeys>),
);

const LIMITATION_KEYS: ReadonlyMap<string, TranslationKeys> = new Map(
  Object.entries({
    code_unavailable: 'com_ui_file_limitation_code_unavailable',
    too_large_direct: 'com_ui_file_limitation_too_large_direct',
    text_too_long: 'com_ui_file_limitation_text_too_long',
    text_truncated: 'com_ui_file_limitation_text_truncated',
    too_large_together: 'com_ui_file_limitation_too_large_together',
    not_prepared: 'com_ui_file_limitation_not_prepared',
    text_only: 'com_ui_file_limitation_text_only',
    not_allowed: 'com_ui_file_limitation_not_allowed',
    no_reader: 'com_ui_file_limitation_no_reader',
    original_missing: 'com_ui_file_limitation_original_missing',
  } satisfies Record<Limitation, TranslationKeys>),
);

/**
 * Describes how an attachment was read on its message's turn. Answers nothing for an absent or
 * unrecognized reader, so the chip keeps its default subtitle and name; an unrecognized
 * limitation leaves the reader on its own.
 */
export function useReadingCaption(): (
  file: Partial<Pick<TFile, 'filename' | 'reading'>>,
) => ReadingCaption | undefined {
  const localize = useLocalize();
  return useCallback(
    ({ filename, reading }: Partial<Pick<TFile, 'filename' | 'reading'>>) => {
      const readerKey = reading == null ? undefined : READER_KEYS.get(reading.reader);
      if (readerKey == null) {
        return undefined;
      }
      const reader = localize(readerKey);
      const limitation = reading?.limitation;
      const reasonKey = limitation == null ? undefined : LIMITATION_KEYS.get(limitation);
      const text =
        reasonKey == null
          ? reader
          : localize('com_ui_file_reading_with_reason', { reader, reason: localize(reasonKey) });
      const label = filename
        ? localize('com_ui_file_reading_label', { filename, reading: text })
        : text;
      return { text, label };
    },
    [localize],
  );
}
