/**
 * The name the download is saved under. The stored file name is neutral
 * (`{uuid}.{ext}`, C-12), so it uses the document's own name, which only its
 * uploader gets here, with the stored extension when the name lacks it.
 */
export function downloadName(docName: unknown, stored: string): string {
  const dot = stored.lastIndexOf('.');
  const ext = dot > 0 ? stored.slice(dot) : '';
  const name = typeof docName === 'string' ? docName.trim() : '';
  if (!name) return stored;
  return ext && !name.toLowerCase().endsWith(ext.toLowerCase()) ? `${name}${ext}` : name;
}
