// Puts an icon and a name into a Windows program (the .exe), so Explorer, the taskbar, Settings > Apps, the Windows
// Firewall prompt and Task Manager show Wandless and not Node.
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

// Windows reads a program's name from its version resource: the Firewall prompt, Task Manager and the file's Properties
// show it. Node's says "Node.js JavaScript Runtime", made by "Node.js". exe: a Buffer. Returns the new program as a Buffer.
// title: 'Wandless VR Video Player'. name: 'Wandless' (the maker shown, and the file name). version: 'x.y.z'.
// Every text Node put there goes, so no field is left that says Node made this program. The copyright line names both:
// the program is Node with the app inside.
export function setDetails(exe, { title, name, version }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`The version must be x.y.z, not "${version}".`);
  const nt = ResEdit.NtExecutable.from(exe, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(nt);
  const found = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  // A program with none gets one (Node has one).
  const { VersionInfo, VersionFileOS, VersionFileType } = ResEdit.Resource;
  const infos = found.length ? found : [VersionInfo.create(1033, { fileOS: VersionFileOS.NT_Windows32, fileType: VersionFileType.App }, [])];
  for (const info of infos) {
    const tables = info.getAllLanguagesForStringValues();
    if (!tables.length) tables.push({ lang: 1033, codepage: 1200 });
    for (const table of tables) {
      info.removeAllStringValues(table, false);
      info.setStringValues(table, {
        CompanyName: name,
        ProductName: title,
        FileDescription: title,
        FileVersion: version,
        ProductVersion: version,
        OriginalFilename: `${name}.exe`,
        InternalName: name,
        LegalCopyright: `Copyright the ${name} authors. MIT license. Built on Node.js: Copyright Node.js contributors. MIT license.`,
      });
    }
    // The numbers beside the texts (Properties > Details > File version reads them).
    const [major, minor, patch] = version.split('.').map(Number);
    info.fixedInfo.fileVersionMS = info.fixedInfo.productVersionMS = ((major << 16) | minor) >>> 0;
    info.fixedInfo.fileVersionLS = info.fixedInfo.productVersionLS = (patch << 16) >>> 0;
    info.outputToResourceEntries(res.entries);
  }
  res.outputResource(nt);
  return Buffer.from(nt.generate());
}

// The name texts of a program, for the tests: one { texts, fileVersion: [major, minor, patch, build] } per language table.
export function details(exe) {
  const nt = ResEdit.NtExecutable.from(exe, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(nt);
  return ResEdit.Resource.VersionInfo.fromEntries(res.entries).flatMap((info) => {
    const { fileVersionMS: ms, fileVersionLS: ls } = info.fixedInfo;
    return info.getAllLanguagesForStringValues().map((table) => ({
      texts: info.getStringValues(table), fileVersion: [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff],
    }));
  });
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
