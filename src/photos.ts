// Fotos im Browser verkleinern, damit der kostenlose Speicher (1 GB) lange reicht.

const FULL_MAX = 1600; // längste Kante in px
const THUMB_MAX = 320;

async function resize(file: Blob, max: number, quality: number): Promise<Blob> {
  // createImageBitmap berücksichtigt die EXIF-Ausrichtung (iOS-Fotos)
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Bild konnte nicht verarbeitet werden"))), "image/jpeg", quality),
  );
}

export async function prepareImage(file: File): Promise<{ full: Blob; thumb: Blob }> {
  let full = await resize(file, FULL_MAX, 0.8);
  if (full.size > 450_000) full = await resize(file, FULL_MAX, 0.65);
  const thumb = await resize(file, THUMB_MAX, 0.7);
  return { full, thumb };
}
