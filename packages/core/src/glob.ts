/** `*` matches any run of characters; everything else is literal. */
export function globMatch(glob: string, value: string): boolean {
  const parts = glob.split('*');
  if (parts.length === 1) return glob === value;
  const first = parts[0] ?? '';
  const last = parts[parts.length - 1] ?? '';
  if (!value.startsWith(first) || value.length < first.length + last.length) return false;
  if (!value.endsWith(last)) return false;
  let pos = first.length;
  const end = value.length - last.length;
  for (const mid of parts.slice(1, -1)) {
    const i = value.indexOf(mid, pos);
    if (i === -1 || i + mid.length > end) return false;
    pos = i + mid.length;
  }
  return true;
}
