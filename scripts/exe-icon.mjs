// Puts an icon into a Windows program (the .exe), so Explorer, the taskbar and Settings > Apps show it and not Node's.
// Build time only: scripts/package.mjs calls it. Nothing in the running program imports it.
import * as ResEdit from 'resedit';

// exe, ico: Buffers. Returns the new program as a Buffer.
// Every icon group the program has gets the new icons (Node has one), so Windows cannot pick an old one. A program with none gets group 1.
// The program's other resources stay, with the Node.js blob that holds the app. The old code signature goes: it was already void once
// the app was put inside, and Windows ignores a program that is merely unsigned.
export function setIcon(exe, ico) {
  const nt = ResEdit.NtExecutable.from(exe, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(nt);
  const icons = ResEdit.Data.IconFile.from(ico).icons.map((item) => item.data);
  if (!icons.length) throw new Error('The icon file holds no image.');
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const targets = groups.length ? groups.map((g) => [g.id, g.lang]) : [[1, 1033]];
  for (const [id, lang] of targets) ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, id, lang, icons);
  res.outputResource(nt);
  return Buffer.from(nt.generate());
}

// The icon groups of a program, for the tests: [{ id, lang, images: [Buffer, ...] }], the image bytes as the program holds them.
export function iconGroups(exe) {
  const nt = ResEdit.NtExecutable.from(exe, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(nt);
  return ResEdit.Resource.IconGroupEntry.fromEntries(res.entries).map((g) => ({
    id: g.id, lang: g.lang, images: g.getIconItemsFromEntries(res.entries).map(imageBytes),
  }));
}

// The images of an .ico file, as the program would hold them.
export function icoImages(ico) {
  return ResEdit.Data.IconFile.from(ico).icons.map((item) => imageBytes(item.data));
}

// PNG images (raw) give their bytes; an old bitmap icon gives null: only the new icon's bytes are compared.
const imageBytes = (item) => (item.isRaw() ? Buffer.from(item.bin) : null);
