# Wandless VR Video Player: user guide

Wandless VR Video Player (Wandless for short) plays VR180 and flat videos on a Meta Quest, in the Meta Quest Browser. You control it with your hands.

- **From your PC:** a small server on a Windows PC streams your video folders to the headset over Wi-Fi.
- **From the headset:** a copy of the player saved on the headset plays videos stored on the headset, with no PC and no network.

Tested on a Meta Quest 3S with the Meta Quest Browser. Other browsers (for example Wolvic) may give the page no hand data.

---

## 1. Install on the PC (once)

You need a Windows PC.

1. Download **Wandless.exe** from the Releases page of Wandless on GitHub.
2. Double-click it. The file is not signed, so Windows may say "Windows protected your PC": click **More info**, then
   **Run anyway**.
3. Wandless installs itself for your Windows user (no administrator password). It puts a **Wandless** shortcut on
   the Desktop and in the Start menu, then starts. You can delete the file you downloaded.
4. Optional, for preview pictures, passthrough videos, audio tracks and the subtitles inside videos: install
   [ffmpeg](https://ffmpeg.org) (with ffprobe, which comes with it). Wandless finds it on the PATH, or in a Jellyfin
   install. Otherwise set `FFMPEG_PATH` to the full path of `ffmpeg.exe`.

**On the first start, Windows Firewall asks about the program.** It may call it Node.js: Wandless is built on it.
Allow it. If your home network is set as "Public" in Windows, allow Public too, or the headset cannot connect.

To remove Wandless: **Settings > Apps > Wandless > Uninstall**. Your videos stay.

## 2. Start Wandless

1. Double-click **Wandless** on the Desktop. A window opens, and the **control page** opens in your browser.
2. Keep the window open while you watch.
3. To stop, press **Stop Wandless** on the control page, or close the window.

The control page shows the address to type on the headset, your folders, the passcode, and the preview progress.
Lost its tab? Double-click **Wandless** again: it opens the control page again. Or open `http://127.0.0.1:8440` on the PC.

**Updates.** At each start, Wandless asks GitHub if there is a new version. When there is one, the window says so, and
the control page shows **Version x.y.z is out**, with what changed. Press **Update now**. Wandless downloads the new
version, checks that it starts on your PC, and then restarts in a new window. Your folders, passcode and previews stay.
Then reload the page on the headset. If you keep the player on the headset for use with no PC, download it again
(section 10).

## 3. Choose a passcode (the first time)

The first time, the control page asks for a **passcode**: digits only, at least 4. Type it twice, then press
**Save the passcode**. Until you do, the headset cannot open anything.

To change it later, use **Passcode** on the control page. The headset asks for the new one at once.
For a password with letters (the headset then shows a full keyboard), tick the box under it.

## 4. Add your video folders

On the control page, under **Video folders**:

- **Add a folder...** opens the normal Windows folder window. Pick a folder.
- Or paste a folder path, then press **Add**. (In File Explorer, right-click a folder, then **Copy as path**.)
- **Remove** takes a folder off the list. The videos stay on the PC.

The first start lists your **Videos** folder. Remove it if you do not want it.

- The headset can open only the folders in this list, and their subfolders. **Do not add a whole drive.**
- A change shows on the headset when you reload the page. Wandless does not need a restart.
- The list is the file `folders.txt`, one folder per line, in the Wandless folder: type `%LOCALAPPDATA%\Wandless` in the
  File Explorer address bar. You can also edit it in Notepad.

## 5. Open the player on the headset

1. Put on the headset. Turn on hand tracking in the Quest settings, if it is off.
2. Open the **Meta Quest Browser**.
3. Type the address from the control page, for example `192.168.1.20`.
4. The first time, the browser warns about the certificate. Tap **Advanced**, then **Proceed**. This is normal: the PC
   made its own certificate.
5. Tap your passcode on the keypad, then **Unlock**.
6. **Bookmark the page** (the star in the address bar). Next time, open the bookmark: no typing.

If the address changes (another network, or a new address from the router), the control page shows the new one.
It also shows when the headset last connected.

The page has three tabs: **Laptop** (your folders), **This headset** (videos stored on the headset) and **How to use**
(the gestures, in short).

## 6. Choose a video

- **Folder:** switches between your folders.
- **Order:** Name, Newest first, Oldest first, Largest first or Smallest first. The headset remembers your choice.
- **Search:** finds videos in the folder and all its subfolders.
- **Subfolders:** tap a folder card to go in. Tap a name in the path line to go back up.
- Each card shows the size and the date of the video.

Tap a video. Its page opens over the list:

- **Picture:** the player guesses the projection (VR180, VR180 fisheye or flat screen) and the 3D layout. Change them
  if the guess is wrong.
- **Audio:** shows when the video has more than one audio track. Choose the language.
- **Subtitles:** shows when the video has subtitles. Choose them, or Off.
- **Speed:** − and + change it by 0.05. Or tap 1×, 1.25×, 1.5×, 1.75× or 2×.

Your audio language, your subtitles and your speed stay for the next video. Then tap **Watch in VR**, or
**Watch in your room** to see your room (passthrough). The ✕ closes the video's page.

## 7. Gestures

**Only a hand you can see counts.** A hand in the bottom quarter of your view, for example on your lap, does nothing.
Raise your hand to about chin height to use it.

A **pinch** is the tip of your thumb on the tip of your index finger.

Your hands are drawn only while you use them: while you pinch, and while the menu is open. Otherwise they stay out
of the picture. They look like smooth, see-through hands and glow orange while they pinch.

| To do this | Do this |
|---|---|
| Open the menu | **Double pinch**: two quick pinches with one hand. |
| Close the menu | Press **X**, pinch anywhere that is not the menu, or look away. It also closes after 8 s with no hand on it. |
| Press a button | Point at it: a ray comes out of your hand. Then pinch. |
| Pause or play | **Prayer hands**: press your palms together, fingers up, at chest height or higher, and hold for a moment, like a clap that stays. A quick clap does nothing. |
| Skip forward 30 s | Flick your **right** hand quickly toward the middle, hand open. |
| Go back 30 s | Flick your **left** hand quickly toward the middle, hand open. |
| Skip more | Flick again at once, as often as you like. The message adds up: +60 s, +90 s. |
| Zoom (VR180) | Pinch with both hands. Move them apart to zoom in, together to zoom out. |
| Turn the picture (VR180) | Pinch with one hand and move it. |
| Move the screen (flat) | Pinch with one hand and move it. |
| Resize the screen (flat) | Pinch with both hands. Move them apart or together. |
| Stop and pick another video | Press **Home** on the menu. |

**The menu** shows by itself for 5 s when you start VR, the first 3 times only. After that, double pinch to open it.
It opens on its main page:
1. Home, -10 s, Play or Pause, +10 s, X.
2. The time, the seek bar and the length. Point at the bar and pinch, or pinch and drag along it.
3. Speed: −, the speed now, +, then 1×, 1.25×, 1.5×, 1.75×, 2×. The + goes on to 3×.
4. **Subtitles** and **Audio** (only when the video has them), **View**, and **Reset view** when there is room.
   In room view, **Passthrough** too.

The other pages have **‹ Back** at the top left and **X** at the top right:
- **View:** the picture (VR180, Fisheye, Flat screen), the 3D layout (2D, Side by side, Top-bottom), Reset view,
  Passthrough.
- **Subtitles:** Off and each subtitle choice. **Earlier** and **Later** move the subtitles by 0.5 s. While the menu
  shows, the subtitles show just above it, so you see the change.
- **Audio:** each audio track.

## 8. Subtitles and audio tracks

**Subtitles.** The laptop finds them in three places:
- a subtitle file next to the video, with the same name: `Film.srt`, `Film.en.srt`, `Film.fr.forced.srt`;
- a `Subs` folder next to the video, as many downloads have (`Subs/2_English.srt`, `Subs/Film/2_English.srt`);
- the text subtitles inside the video (often in MKV files). The laptop needs ffmpeg for these. It takes them out
  when you open the video's page; a big file takes some seconds.

Picture subtitles (from a DVD or a Blu-ray) cannot show. In VR, the subtitles show over the bottom of a flat screen.
With a VR180 video, they show in front of you, a little low.

**A video stored on the headset.** The page can open only the files you pick, so it cannot find the subtitles by
itself. In **Choose a video**, pick the video and its subtitle file together: press and hold the first file, then tap
the other. Or open the video, then tap **Add a file**. Subtitles inside a video work only from the PC.

**To take a PC video's subtitles to the headset:** on the video's page, choose the subtitles, then tap **Download these
subtitles too**. They get the video's name, so you find them next to it.

**Audio tracks.** For a video with more than one audio track, choose the language on the video's page or on the
**Audio** page of the menu. For another track than the video's own, the laptop sends that track as a second sound
stream, kept in time with the picture. The laptop needs ffmpeg for this.

## 9. Passthrough (see your room)

1. Tap **Watch in your room** before you go in. It shows only when the browser can do it.
2. In VR, the **Passthrough** button on the menu shows or hides the room.

What you see depends on the video:

- **A flat video:** the screen floats in your room.
- **A VR180 video:** it fills your view, so it becomes half see-through. Zoom out with two hands to see the room round a
  smaller picture.
- **A passthrough video** (made for passthrough, with a "mask" that cuts the person out): the person stands in your room.
  The rest of the picture is gone.

- **A passthrough video with a filled background** (one colour round the person: often green, violet or black): the
  colour goes and the person stands in your room. On the video's page, **Your room** says what it does, for example
  "Remove the green background". Choose **Show all of the picture** to keep the whole picture. A black background
  also takes the darkest shadows of the person: if it takes too much, choose Show all of the picture.

The player finds passthrough videos by itself: it reads the video's pictures. The PC checks the first folder at start.
A file it has not checked yet takes a few seconds the first time you pick it. A video stored on the headset is checked
by the page when you pick it.

If a passthrough video is not found: choose **VR180 fisheye** and tick **Passthrough video: cut the person out** for
a video with a mask (red corners), or choose **Remove a black background** under Your room.

## 10. Videos on the headset, with no PC (airplane mode)

You do not need the PC or the network for videos stored on the headset. You need a copy of the player **on the headset**.

**Once, at home, with the PC on:**
1. Open the player page from the PC. On the **This headset** tab, tap **Download the player to this headset**.
   The headset saves `wandless.html` in its `Download` folder. Do this again after each update of the player.
2. Put videos on the headset. Two ways:
   - Open a video in the library, then tap **Download this video to the headset**. It goes into the `Download` folder.
     A big file takes minutes. With subtitles on, also tap **Download these subtitles too**.
   - Or copy videos with a USB cable, for example into the headset's `Movies` folder.
3. In the Quest Browser, open `file:///sdcard/Download/wandless.html` and bookmark it.

**On the plane (airplane mode):**
1. Open the bookmark.
2. Tap **Choose a video** and pick a video on the headset. To have its subtitles, pick the subtitle file (SRT,
   WebVTT or ASS) with it: press and hold the first file, then tap the other.
3. Tap **Watch in VR**.

The offline copy has no folder list and no passcode. It plays only the files you choose.

**Not proven on a Quest yet.** Test it at home with Wi-Fi off before a trip.

## 11. Problems

| Problem | Try this |
|---|---|
| The headset cannot open the address | Check that the headset and the PC are on the same Wi-Fi. A guest or public Wi-Fi often blocks devices from each other: turn on the PC's **Mobile hotspot** and connect the headset to it. The address is then `192.168.137.1`. Check that Windows Firewall allows Node.js. |
| Only the full address works | Port 80 is busy on the PC. The control page then shows the full address, for example `https://192.168.1.20:8443/`. Type all of it. |
| The control page does not open | Open `http://127.0.0.1:8440` in a browser on the PC. If the Wandless window says the control page could not start, another program uses port 8440. |
| You forgot the passcode | Choose a new one on the control page. It does not ask for the old one: only this PC can open the control page. |
| The folder window does not show | Look in the taskbar for it. Or paste the folder path instead. |
| Hands do nothing in VR | Use the **Meta Quest Browser**. Tap the icon at the left of the address bar, set Hand tracking to **Allow**, and reload. |
| The menu does not open | Raise your hand into your view and double pinch quickly. |
| A video does not play | MP4 with H.264, H.265 or AV1 video and AAC sound works best. AC3 and EAC3 sound work too. MKV files are not proven on the Quest yet. DTS sound does not play: choose another audio track, or convert the file. |
| The picture looks wrong | Change the picture settings on the video's page, or on the **View** page of the menu in VR. |
| A passthrough video shows red corners | Choose **VR180 fisheye** and tick the passthrough box. |
| A passthrough video shows its coloured background, or looks see-through | On the video's page, look at **Your room**. Choose the background to remove. A coloured background is found by itself; for a black one, choose **Remove a black background**. |
| Subtitles come too early or too late | On the **Subtitles** page of the menu, press **Earlier** or **Later** (0.5 s each time). |
| No Subtitles or Audio in the list | The laptop finds subtitle files only next to the video or in a `Subs` folder. The subtitles and audio tracks inside a video need ffmpeg on the PC (see section 1). |
| The second audio track stutters | The laptop sends it over Wi-Fi beside the video. Move closer to the router, or use the PC's Mobile hotspot. |
| An update fails | The control page says why. Check the internet connection, then press **Update now** again. Wandless keeps the version you have until a new one is fully checked. |
| "Could not check for updates" | The PC could not reach GitHub. Wandless works as before. It asks again at the next start, or press **Check for updates**. |

## 12. Privacy

- The passcode protects the player. After a few wrong tries, the PC makes you wait longer and longer.
  A session lasts 12 hours. The **Lock** button ends it.
- The headset can open only the folders in `folders.txt`.
- The control page answers only on this PC (`127.0.0.1`), never on the Wi-Fi. Anyone who uses this PC can open it.
- The player has no account and no tracking. One thing leaves your network: at each start, Wandless asks GitHub if
  there is a new version. GitHub sees your internet address. Nothing else is sent.
- Wandless keeps a small gesture log on the PC (`.state\session-log.jsonl` in the Wandless folder): how the menu opened and closed, swipes,
  pinches. It holds no video names. It helps to tune the gestures. Download or clear it on the control page.

## 13. Donate

Wandless is free. If you like it, send sats to the Lightning address `sats4ai@blink.sv`, or open
<https://pay.blink.sv/sats4ai>. Any Lightning wallet can pay it. Wandless itself never asks for money and never opens
this page.
