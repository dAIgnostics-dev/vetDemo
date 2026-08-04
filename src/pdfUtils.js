import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

// Claude downscales images to 1568px on the long edge, so anything larger is
// paid for in tokens and discarded.
const MAX_EDGE_PX = 1568;

// AppSync rejects requests over 1MB. Base64 inflates by ~33%, and the rest of
// the GraphQL envelope needs room too.
const MAX_BASE64_BYTES = 700 * 1024;

const JPEG_QUALITY_STEPS = [0.85, 0.7, 0.55, 0.4];

// Below this, the "text layer" is usually just a scanner watermark or page
// number rather than the actual document content.
const MIN_TEXT_LAYER_CHARS = 120;

export async function loadPdf(file) {
  const buffer = await file.arrayBuffer();
  return pdfjsLib.getDocument({ data: buffer }).promise;
}

export async function extractTextLayer(pdf, pageNumber = 1) {
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  const text = content.items
    .map((item) => (typeof item.str === "string" ? item.str : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return text.length >= MIN_TEXT_LAYER_CHARS ? text : null;
}

export async function renderPageToImage(pdf, pageNumber = 1) {
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const fitScale =
    MAX_EDGE_PX / Math.max(baseViewport.width, baseViewport.height);
  const viewport = page.getViewport({ scale: Math.min(fitScale, 4) });

  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);

  await page.render({ canvas, viewport }).promise;

  for (const quality of JPEG_QUALITY_STEPS) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    const base64 = dataUrl.split(",")[1];
    if (base64.length <= MAX_BASE64_BYTES) {
      return { dataUrl, base64, quality };
    }
  }

  const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY_STEPS.at(-1));
  return {
    dataUrl,
    base64: dataUrl.split(",")[1],
    quality: JPEG_QUALITY_STEPS.at(-1),
    oversized: true,
  };
}

export async function processPdfFile(file) {
  const pdf = await loadPdf(file);
  try {
    console.time("processPdfFile");

    // Running text extraction and page rendering in parallel on the same page
    // can stall in pdf.js. Keep this flow strictly sequential.
    console.time("extractTextLayer");
    const pdfText = await extractTextLayer(pdf, 1);
    console.timeEnd("extractTextLayer");

    console.time("renderPageToImage");
    const image = await renderPageToImage(pdf, 1);
    console.timeEnd("renderPageToImage");

    return {
      pageCount: pdf.numPages,
      pdfText,
      previewUrl: image.dataUrl,
      imageBase64: image.base64,
      oversized: Boolean(image.oversized),
    };
  } finally {
    console.timeEnd("processPdfFile");
    try {
      await pdf.cleanup();
    } catch (error) {
      const message = String(error?.message || "");
      if (!message.includes("is currently rendering")) {
        console.warn("pdf cleanup failed:", error);
      }
    }
    await pdf.loadingTask.destroy();
  }
}
