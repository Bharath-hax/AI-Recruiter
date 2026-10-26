import fs from 'fs/promises';
import path from 'path';
import JSZip from 'jszip';

const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.aistudio',
  '.local-pgdata',
  'drizzle',
]);

const EXCLUDED_FILES = new Set([
  '.env',
  'bun.lock',
  'package-lock.json',
]);

async function addDirectoryToZip(
  zipFolder: JSZip,
  absDirPath: string
): Promise<void> {
  const entries = await fs.readdir(absDirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const subFolder = zipFolder.folder(entry.name);
      if (subFolder) {
        await addDirectoryToZip(subFolder, path.join(absDirPath, entry.name));
      }
    } else if (entry.isFile()) {
      if (EXCLUDED_FILES.has(entry.name)) continue;
      // Never export live firebase-applet-config secrets if user wants clean template,
      // though keeping public web config + .env.example ensures immediate runnable parity
      const fullPath = path.join(absDirPath, entry.name);
      const data = await fs.readFile(fullPath);
      zipFolder.file(entry.name, data);
    }
  }
}

export async function buildCodebaseZipBuffer(workspaceRoot: string): Promise<Buffer> {
  const zip = new JSZip();
  const rootFolder = zip.folder('ai-review-automation');
  if (!rootFolder) {
    throw new Error('Failed to initialize ZIP archive root folder.');
  }

  await addDirectoryToZip(rootFolder, workspaceRoot);

  return await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}
