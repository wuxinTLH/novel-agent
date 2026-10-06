export const TEXT_ASSET_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_ASSET_MAX_BYTES = 4 * 1024 * 1024;

export function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}
