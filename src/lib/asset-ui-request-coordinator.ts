export type AssetUiRequestCoordinator = {
  beginMetadata(): number;
  isCurrentMetadata(version: number): boolean;
  beginSignedUrl(fileId: string): number;
  isCurrentSignedUrl(fileId: string, version: number): boolean;
  unmount(): void;
};

export type AssetUiSignedFileRetryState = {
  autoRetried?: boolean;
  isLoading?: boolean;
};

export function shouldStartAutomaticImageRetry(state: AssetUiSignedFileRetryState | undefined): boolean {
  return !state?.autoRetried && !state?.isLoading;
}

export function createAssetUiRequestCoordinator(): AssetUiRequestCoordinator {
  let mounted = true;
  let metadataVersion = 0;
  const signedUrlVersions = new Map<string, number>();

  return {
    beginMetadata() {
      metadataVersion += 1;
      return metadataVersion;
    },
    isCurrentMetadata(version: number) {
      return mounted && version === metadataVersion;
    },
    beginSignedUrl(fileId: string) {
      const nextVersion = (signedUrlVersions.get(fileId) ?? 0) + 1;
      signedUrlVersions.set(fileId, nextVersion);
      return nextVersion;
    },
    isCurrentSignedUrl(fileId: string, version: number) {
      return mounted && version === signedUrlVersions.get(fileId);
    },
    unmount() {
      mounted = false;
      metadataVersion += 1;
      for (const [fileId, version] of signedUrlVersions) {
        signedUrlVersions.set(fileId, version + 1);
      }
    },
  };
}
