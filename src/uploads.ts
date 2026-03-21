import * as fs from "fs";
import * as path from "path";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

function extFromMime(mime: string): string {
  switch (mime.toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/bmp":
      return "bmp";
    default:
      return "bin";
  }
}

function parseDataUrl(dataUrl: string): { mime: string; buffer: Buffer } | null {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  try {
    return {
      mime: m[1],
      buffer: Buffer.from(m[2], "base64"),
    };
  } catch {
    return null;
  }
}

export function persistInlineImage(stackId: string, cardId: string, imageUrl: string): string {
  if (!/^data:/i.test(imageUrl)) return imageUrl;
  const parsed = parseDataUrl(imageUrl);
  if (!parsed) return imageUrl;
  const ext = extFromMime(parsed.mime);
  const stackDir = path.join(UPLOADS_DIR, stackId);
  if (!fs.existsSync(stackDir)) {
    fs.mkdirSync(stackDir, { recursive: true });
  }
  const filename = `${cardId}.${ext}`;
  const targetPath = path.join(stackDir, filename);
  fs.writeFileSync(targetPath, parsed.buffer);
  return `/api/uploads/${encodeURIComponent(stackId)}/${encodeURIComponent(filename)}`;
}

export function getUploadsDir(): string {
  return UPLOADS_DIR;
}
