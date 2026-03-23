import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".rtf": "application/rtf",
  ".txt": "text/plain",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

function getMimeType(filePath: string): string {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

export async function appendFilesToFormData(formData: FormData, filePaths: string[]): Promise<void> {
  if (!filePaths.length) {
    throw new Error("At least one file path is required");
  }
  if (filePaths.length > 10) {
    throw new Error("At most 10 files can be uploaded in one request");
  }

  for (const filePath of filePaths) {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new Error(`Path is not a file: ${filePath}`);
    }
    const buffer = await readFile(filePath);
    const file = new File([buffer], path.basename(filePath), {
      type: getMimeType(filePath)
    });
    formData.append("files", file);
  }
}

export async function maybeReadBase64File(filePath: string | undefined): Promise<string | undefined> {
  if (!filePath) {
    return undefined;
  }
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error(`Path is not a file: ${filePath}`);
  }
  const buffer = await readFile(filePath);
  return buffer.toString("base64");
}
