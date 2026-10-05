import { useMemo, useState, useCallback, memo } from 'react';
import type { TFile, TMessage } from 'librechat-data-provider';
import FileContainer from '~/components/Chat/Input/Files/FileContainer';
import { usesImagePreview, hydrateFileDeliveryMetadata } from '~/utils';
import { useFileMapContext, useShareContext } from '~/Providers';
import FilePreviewDialog from './FilePreviewDialog';
import { useReadingCaption } from './reading';
import Image from './Image';

type MessageFile = NonNullable<TMessage['files']>[number];

/** An image nothing read keeps its chip, so it shows the notice instead of a preview. */
const showsImagePreview = (file: MessageFile): boolean =>
  usesImagePreview(file) && file.reading?.reader !== 'unavailable';

const Files = ({ message }: { message?: TMessage }) => {
  const fileMap = useFileMapContext();
  const { shareId } = useShareContext();
  const captionReading = useReadingCaption();
  const files = useMemo(
    () => hydrateFileDeliveryMetadata(message?.files, undefined, shareId ? undefined : fileMap),
    [message?.files, fileMap, shareId],
  );
  const { imageFiles, otherFiles } = useMemo(() => {
    const images: MessageFile[] = [];
    const others: MessageFile[] = [];
    for (const file of files ?? []) {
      (showsImagePreview(file) ? images : others).push(file);
    }
    return { imageFiles: images, otherFiles: others };
  }, [files]);

  const [selectedFile, setSelectedFile] = useState<Partial<TFile> | null>(null);

  const handleClose = useCallback((open: boolean) => {
    if (!open) {
      setSelectedFile(null);
    }
  }, []);

  return (
    <>
      {otherFiles.length > 0 &&
        otherFiles.map((file) => {
          const caption = captionReading(file);
          return (
            <FileContainer
              key={file.file_id}
              file={file as TFile}
              subtitle={caption?.text}
              ariaLabel={caption?.label}
              onClick={() => setSelectedFile(file)}
            />
          );
        })}
      {imageFiles.length > 0 &&
        imageFiles.map((file) => (
          <Image
            key={file.file_id}
            alignRight
            imagePath={file.preview ?? file.filepath ?? ''}
            height={file.height ?? 1920}
            width={file.width ?? 1080}
            altText={file.filename ?? 'Uploaded Image'}
          />
        ))}
      <FilePreviewDialog
        open={selectedFile !== null}
        onOpenChange={handleClose}
        fileName={selectedFile?.filename ?? ''}
        fileId={selectedFile?.file_id}
        filePath={selectedFile?.filepath}
        fileType={selectedFile?.type ?? undefined}
        fileSource={selectedFile?.source}
        fileSize={(selectedFile as TFile)?.bytes}
        deliveryPath={selectedFile?.llmDeliveryPath}
      />
    </>
  );
};

export default memo(Files);
