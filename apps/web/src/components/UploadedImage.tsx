import { useUploadedImage } from "../lib/session.js";

/**
 * An image a citizen uploaded, read through the board. One the board does not have, or cannot
 * give, reads as its description, with the board's reason on hover.
 */
export function UploadedImage({ id, alt }: { id: string; alt: string }) {
  const image = useUploadedImage(id);
  const name = alt === "" ? "an image" : alt;
  if (image.data !== undefined) {
    return <img src={image.data} alt={alt} className="max-h-[32rem] max-w-full rounded-lg" />;
  }
  if (image.isPending) {
    return <span className="text-meta">Loading {name}…</span>;
  }
  return <span title={image.error?.message}>{name}</span>;
}
