import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeText, parseSubtitles, cueText, cleanCueText, wrapLines, languageTag, languageName, baseLanguage, readSubtitleTag,
  describeSubtitle, audioLabel, numberSameLabels, orderByLanguage, pickSubtitle, syncAudio, clampSpeed, stepSpeed,
  formatSpeed, SPEED_PRESETS, SPEED_MIN, SPEED_MAX, compareBy, listFolder, formatSize, subtitleTag, cuesToSrt,
} from '../public/core.js';

test('subtitleTag: the language words of a file picked on the headset, never a word of the movie title', () => {
  assert.equal(subtitleTag('Batman.Bad.Blood.2016.en.srt', 'Batman.Bad.Blood.2016.mkv'), 'en', 'after the video\'s own name');
  assert.equal(subtitleTag('Batman.Bad.Blood.2016.720p.en.forced.srt', 'something else.mkv'), 'en.forced', 'the words at the end');
  assert.equal(subtitleTag('Batman.Bad.Blood.srt', 'other.mkv'), '', '"Bad" (Banda) and "Blood" are the title');
  assert.equal(describeSubtitle({ source: 'file', tag: subtitleTag('Batman.Bad.Blood.srt', 'other.mkv') }).language, '');
  assert.equal(describeSubtitle({ source: 'file', tag: subtitleTag('Batman.Bad.Blood.2016.fre.srt', 'other.mkv') }).language, 'fre');
  assert.equal(subtitleTag('2_English.srt', 'Film.mkv'), '2_English', 'no dot: the whole name');
  assert.equal(describeSubtitle({ source: 'file', tag: '2_English' }).label, 'English');
  assert.equal(subtitleTag('Film.srt', 'Film.mkv'), '', 'named like the video: no language word');
});

test('cuesToSrt: numbered cues, HH:MM:SS,mmm times, lines kept; the player reads it back the same', () => {
  const cues = [[1, 4.5, 'First line'], [3725.25, 3727, 'Two\nlines']];
  const srt = cuesToSrt(cues);
  assert.equal(srt, '1\r\n00:00:01,000 --> 00:00:04,500\r\nFirst line\r\n\r\n2\r\n01:02:05,250 --> 01:02:07,000\r\nTwo\r\nlines\r\n');
  assert.deepEqual(parseSubtitles(srt).map((c) => [c.start, c.end, c.text]), cues);
});

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not near ${b}`);

test('decodeText: UTF-8, UTF-8 with a BOM, UTF-16 with a BOM, and old Windows-1252 files', () => {
  assert.equal(decodeText(Buffer.from('Été déjà', 'utf8')), 'Été déjà');
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Ça va', 'utf8')])), 'Ça va');
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Noël', 'utf16le')])), 'Noël');
  const be = Buffer.from('Noël', 'utf16le').swap16();
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), 'Noël');
  assert.equal(decodeText(Buffer.from([0x45, 0x74, 0xe9, 0x20, 0x80])), 'Eté €', 'bytes that are not UTF-8 are read as Windows-1252');
  assert.equal(decodeText(Buffer.from([0x63, 0x9c, 0x75, 0x72, 0x20, 0x6c, 0x92, 0xe9, 0x74, 0xe9, 0x85])), 'cœur l’été…', 'the French marks of Windows-1252');
});

test('parseSubtitles: SRT with commas, dots, short hours, tags, entities and a missing blank line', () => {
  const srt = [
    '1', '00:00:01,000 --> 00:00:03,500', 'Hello <i>world</i>', '{\\an8}up here &amp; now', '',
    '2', '0:00:04.25 --> 0:00:06.000 X1:10 X2:20', '  Second  ', '3', // the next number, with no blank line before it
    '00:01:02,003 --> 00:01:04,000', '<font color="#ff0000">Red</font> text', '',
    '4', '00:01:05,000 --> 00:01:05,000', 'zero length: dropped', '',
    '5', '00:01:06,000 --> 00:01:07,000', '', // no words: dropped
  ].join('\r\n');
  const cues = parseSubtitles(srt);
  assert.deepEqual(cues, [
    { start: 1, end: 3.5, text: 'Hello world\nup here & now' },
    { start: 4.25, end: 6, text: 'Second' },
    { start: 62.003, end: 64, text: 'Red text' },
  ]);
});

test('parseSubtitles: WebVTT with a header, a note, cue names, settings and minutes-only times', () => {
  const vtt = 'WEBVTT\n\nNOTE made by hand\n\nintro\n00:01.000 --> 00:02.500 align:start position:10%\n<v Anna>Hi there</v>\n\n'
    + '02:00:00.000 --> 02:00:01.000\n<c.yellow>Late</c> <00:00:01.500>words\n';
  assert.deepEqual(parseSubtitles(vtt), [{ start: 1, end: 2.5, text: 'Hi there' }, { start: 7200, end: 7201, text: 'Late words' }]);
});

test('parseSubtitles: ASS events with their own field order, commas in the text, line breaks and drawings', () => {
  const ass = [
    '[Script Info]', 'Title: test', '', '[V4+ Styles]', 'Format: Name, Fontname', 'Style: Default,Arial', '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:02.00,0:00:04.50,Default,,0,0,0,,{\\i1}Well,{\\i0} yes\\Nand no',
    'Comment: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,not shown',
    'Dialogue: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100',
    'Dialogue: 0,1:00:00.10,1:00:01.00,Default,,0,0,0,,Late\\hone',
  ].join('\n');
  assert.deepEqual(parseSubtitles(ass), [{ start: 2, end: 4.5, text: 'Well, yes\nand no' }, { start: 3600.1, end: 3601, text: 'Late one' }]);
  const reordered = '[Events]\nFormat: Start, End, Text\nDialogue: 0:00:01.00,0:00:02.00,Moved, fields\n';
  assert.deepEqual(parseSubtitles(reordered), [{ start: 1, end: 2, text: 'Moved, fields' }]);
});

test('cueText: the cue at a time, overlapping cues together, nothing between cues', () => {
  const cues = parseSubtitles('1\n00:00:01,000 --> 00:00:10,000\nA long sign\n\n2\n00:00:02,000 --> 00:00:03,000\nSpeech\n\n'
    + '3\n00:00:20,000 --> 00:00:21,000\nLater\n');
  assert.equal(cueText(cues, 0.5), '');
  assert.equal(cueText(cues, 1), 'A long sign');
  assert.equal(cueText(cues, 2.5), 'A long sign\nSpeech');
  assert.equal(cueText(cues, 3), 'A long sign', 'a cue ends at its end time');
  assert.equal(cueText(cues, 15), '');
  assert.equal(cueText(cues, 20.5), 'Later');
  assert.equal(cueText([], 5), '');
  const many = Array.from({ length: 2000 }, (_, i) => ({ start: i, end: i + 0.5, text: `cue ${i}` }));
  assert.equal(cueText(many, 1234.2), 'cue 1234');
  assert.equal(cueText(many, 1234.7), '');
});

test('cleanCueText and wrapLines', () => {
  assert.equal(cleanCueText('<b> a </b>\n\n{\\pos(1,2)}b&nbsp;c'), 'a\nb c');
  const measure = (s) => s.length * 10; // 10 px a letter
  assert.deepEqual(wrapLines('one two three four', 100, measure), ['one two', 'three four']);
  assert.deepEqual(wrapLines('one two three four', 95, measure), ['one two', 'three', 'four']);
  assert.deepEqual(wrapLines('keep\nmy lines', 1000, measure), ['keep', 'my lines']);
  assert.deepEqual(wrapLines('averyveryverylongword x', 50, measure), ['averyveryverylongword', 'x'], 'a long word stays whole');
  assert.deepEqual(wrapLines('a b c d e f', 10, measure, 3), ['a', 'b', 'c'], 'three lines at most');
});

test('language codes and names: two-letter, three-letter (both kinds), regions, and non-languages', () => {
  assert.equal(languageTag('eng'), 'en');
  assert.equal(languageTag('fre'), 'fr');
  assert.equal(languageTag('fra'), 'fr');
  assert.equal(languageTag('fr_CA'), 'fr-CA');
  assert.equal(languageTag('frc'), 'fr-CA', 'the ".frc" files of Jellyfin and OpenSubtitles are Canadian French');
  assert.equal(languageTag('und'), '');
  assert.equal(languageTag(''), '');
  assert.equal(languageTag('english'), '', 'a word is not a code');
  assert.equal(languageName('eng'), 'English');
  assert.equal(languageName('ger'), 'German');
  assert.equal(languageName('chi'), 'Chinese');
  assert.equal(languageName('fr-CA'), 'Canadian French');
  assert.equal(languageName('pt-br'), 'Brazilian Portuguese');
  assert.equal(languageName('xyz'), '', 'an unknown code has no name');
  assert.equal(baseLanguage('fr-CA'), 'fr');
  assert.equal(baseLanguage('fre'), 'fr');
  assert.equal(baseLanguage('none'), '');
});

test('readSubtitleTag: the words after the video name, and the names in a Subs folder', () => {
  assert.deepEqual(readSubtitleTag('eng.hi'), { language: 'eng', hi: true, forced: false, extra: '' });
  assert.deepEqual(readSubtitleTag('fra.sdh'), { language: 'fra', hi: true, forced: false, extra: '' });
  assert.deepEqual(readSubtitleTag('fr.forced'), { language: 'fr', hi: false, forced: true, extra: '' });
  assert.deepEqual(readSubtitleTag('eng.0'), { language: 'eng', hi: false, forced: false, extra: '' });
  assert.deepEqual(readSubtitleTag('2_English'), { language: 'en', hi: false, forced: false, extra: '' });
  assert.deepEqual(readSubtitleTag('3_French [SDH]'), { language: 'fr', hi: true, forced: false, extra: '' });
  assert.deepEqual(readSubtitleTag('hi'), { language: 'hi', hi: false, forced: false, extra: '' }, 'alone, "hi" is Hindi');
  assert.deepEqual(readSubtitleTag('pt-BR'), { language: 'pt-BR', hi: false, forced: false, extra: '' });
  assert.deepEqual(readSubtitleTag(''), { language: '', hi: false, forced: false, extra: '' });
  assert.deepEqual(readSubtitleTag('Director comments'), { language: '', hi: false, forced: false, extra: 'Director comments' });
});

test('describeSubtitle and audioLabel: labels people read', () => {
  assert.equal(describeSubtitle({ source: 'file', tag: 'eng.hi' }).label, 'English (SDH)');
  assert.equal(describeSubtitle({ source: 'file', tag: '' }).label, 'Subtitle file');
  assert.equal(describeSubtitle({ source: 'file', tag: 'frc' }).label, 'Canadian French');
  assert.equal(describeSubtitle({ source: 'video', language: 'fre', title: '', forced: true }).label, 'French (forced)');
  assert.equal(describeSubtitle({ source: 'video', language: 'eng', title: 'English SDH', hi: true }).label, 'English SDH', 'a title that names the language is enough');
  assert.equal(describeSubtitle({ source: 'video', language: 'spa', title: 'Latin America' }).label, 'Spanish · Latin America');
  assert.equal(describeSubtitle({ source: 'video', language: 'und', title: '' }).label, 'Subtitles');
  const d = describeSubtitle({ source: 'file', tag: 'fra.forced' });
  assert.equal(d.language, 'fra');
  assert.equal(d.forced, true);
  assert.equal(audioLabel({ language: 'eng', channels: 6 }), 'English · 5.1');
  assert.equal(audioLabel({ language: 'fre', channels: 2, title: 'Commentary' }), 'French · Commentary · stereo');
  assert.equal(audioLabel({ language: 'und', channels: 8 }, 2), 'Track 3 · 7.1');
  assert.deepEqual(numberSameLabels(['English', 'French', 'English', 'English']), ['English', 'French', 'English 2', 'English 3']);
});

test('orderByLanguage and pickSubtitle: your languages first, a remembered choice comes back', () => {
  const subs = ['spa', 'eng', 'fre', 'eng'].map((language, i) => describeSubtitle({ source: 'video', language, title: '', hi: i === 3 }));
  assert.deepEqual(orderByLanguage(subs, ['fr', 'en']).map((s) => s.label), ['French', 'English', 'English (SDH)', 'Spanish']);
  assert.equal(pickSubtitle(subs, { lang: 'en', hi: true }).label, 'English (SDH)');
  assert.equal(pickSubtitle(subs, { lang: 'en', hi: false }).label, 'English');
  assert.equal(pickSubtitle(subs, { lang: 'de' }), null, 'a language the video does not have: none');
  assert.equal(pickSubtitle(subs, null), null);
  const forcedOnly = [describeSubtitle({ source: 'video', language: 'fre', forced: true }), describeSubtitle({ source: 'video', language: 'fre' })];
  assert.equal(pickSubtitle(forcedOnly, { lang: 'fr' }).label, 'French', 'full subtitles before forced ones');
});

test('syncAudio: jump when far apart, nudge the speed a little when close, nothing when in time', () => {
  assert.deepEqual(syncAudio(0.5, 1), { jump: true, rate: 1 });
  assert.deepEqual(syncAudio(-0.31, 1.5), { jump: true, rate: 1.5 });
  assert.deepEqual(syncAudio(0.16, 1), { jump: true, rate: 1 }, 'lips out of time by more than 0.15 s: jump');
  assert.deepEqual(syncAudio(NaN, 1), { jump: true, rate: 1 });
  assert.deepEqual(syncAudio(0.02, 1.65), { jump: false, rate: 1.65 });
  const ahead = syncAudio(0.04, 1); // the audio is ahead: it plays a little slower
  assert.equal(ahead.jump, false);
  near(ahead.rate, 0.96);
  near(syncAudio(-0.035, 2).rate, 2 * 1.035);
  near(syncAudio(0.1, 1).rate, 0.95); // 50 ms or more: the full 5 %, it closes in about a second
  near(syncAudio(0.14, 1).rate, 0.95); // never more than 5 %
});

test('speed: presets, 0.05 steps, limits, and the label', () => {
  assert.deepEqual(SPEED_PRESETS, [1, 1.25, 1.5, 1.75, 2]);
  assert.equal(stepSpeed(1.6, 1), 1.65);
  assert.equal(stepSpeed(1.65, -1), 1.6);
  assert.equal(stepSpeed(1, 1), 1.05);
  let r = 1.5;
  for (let i = 0; i < 3; i++) r = stepSpeed(r, 1);
  assert.equal(r, 1.65, 'three steps from 1.5 make exactly 1.65');
  assert.equal(stepSpeed(SPEED_MAX, 1), SPEED_MAX);
  assert.equal(stepSpeed(SPEED_MIN, -1), SPEED_MIN);
  assert.equal(stepSpeed(1.33, 1), 1.4, 'a speed off the grid steps onto it');
  assert.equal(clampSpeed(9), 3);
  assert.equal(clampSpeed('nonsense'), 1);
  assert.equal(formatSpeed(1), '1×');
  assert.equal(formatSpeed(1.5), '1.5×');
  assert.equal(formatSpeed(1.65), '1.65×');
});

test('sorting: name, newest, oldest, largest, smallest; folders by their newest video and their total size', () => {
  const files = [
    { path: 'b.mp4', name: 'b.mp4', size: 300, date: 1000 },
    { path: 'a10.mp4', name: 'a10.mp4', size: 100, date: 3000 },
    { path: 'a9.mp4', name: 'a9.mp4', size: 200, date: 2000 },
    { path: 'old/x.mp4', name: 'x.mp4', size: 50, date: 500 },
    { path: 'old/y.mp4', name: 'y.mp4', size: 60, date: 600 },
    { path: 'new/z.mp4', name: 'z.mp4', size: 1000, date: 9000 },
  ];
  const names = (how) => listFolder(files, '', how).files.map((f) => f.name).join(' ');
  assert.equal(names('name'), 'a9.mp4 a10.mp4 b.mp4', 'numbers in names count as numbers');
  assert.equal(names('new'), 'a10.mp4 a9.mp4 b.mp4');
  assert.equal(names('old'), 'b.mp4 a9.mp4 a10.mp4');
  assert.equal(names('big'), 'b.mp4 a9.mp4 a10.mp4');
  assert.equal(names('small'), 'a10.mp4 a9.mp4 b.mp4');
  const top = listFolder(files, '', 'new');
  assert.deepEqual(top.folders, [{ name: 'new', count: 1, size: 1000, date: 9000 }, { name: 'old', count: 2, size: 110, date: 600 }]);
  assert.deepEqual(listFolder(files, '', 'small').folders.map((f) => f.name), ['old', 'new']);
  assert.deepEqual(listFolder(files, '', 'name').folders.map((f) => f.name), ['new', 'old']);
  const tie = [{ name: 'b', size: 1, date: 5 }, { name: 'a', size: 1, date: 5 }];
  assert.deepEqual([...tie].sort(compareBy('new')).map((f) => f.name), ['a', 'b'], 'a tie keeps the name order');
  const search = [{ path: 'z/a.mp4' }, { path: 'a/z.mp4' }];
  assert.deepEqual([...search].sort(compareBy('name', 'path')).map((f) => f.path), ['a/z.mp4', 'z/a.mp4']);
});

test('formatSize: KB, MB, GB with one decimal under 10 GB', () => {
  assert.equal(formatSize(500), '1 KB');
  assert.equal(formatSize(850 * 1048576), '850 MB');
  assert.equal(formatSize(3.44 * 1073741824), '3.4 GB');
  assert.equal(formatSize(12.6 * 1073741824), '13 GB');
  assert.equal(formatSize(undefined), '');
});
