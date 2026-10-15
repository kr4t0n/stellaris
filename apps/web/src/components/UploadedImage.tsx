import { useUploadedImage } from "../lib/session.js";
import { EnlargeableImage } from "./EnlargeableImage.js";

/**
 * An image a citizen uploaded, read through the board, which a click enlarges. One the board does
 * not have, or cannot give, reads as its description, with the board's reason on hover.
 */
export function UploadedImage({ id, alt }: { id: string; alt: string }) {
  const image = useUploadedImage(id);
  const name = alt === "" ? "an image" : alt;
  if (image.data !== undefined) {
    return <EnlargeableImage src={image.data} alt={alt} />;
  }
  if (image.isPending) {
    return <span className="text-meta">Loading {name}…</span>;
  }
  return <span title={image.error?.message}>{name}</span>;
}
