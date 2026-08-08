# Audio asset notes

The game code expects these music files to exist in this folder:

- `menu.mp3` — looped on non-racing/menu pages.
- `music.mp3` — looped during active racing in `index.html`.

`js/PageMusic.js` tries `menu.mp3` first. If `menu.mp3` is missing or fails to decode, it temporarily falls back to `music.mp3` so menu pages are not silent, but the intended fix is to provide a valid `menu.mp3` here.

If either track starts slowly, do not change game code first. Re-export or replace the asset yourself with a web-optimized version:

1. Keep the same filename unless you also update the matching code reference.
2. Use a short encoder delay / gapless-friendly export so loops do not click or pause.
3. Compress long tracks to a smaller bitrate, or provide an `.ogg` version and update the code references if you want faster decode on browsers that prefer Ogg/Vorbis.
4. Keep the file size small enough for mobile connections; very large MP3s may not start until the browser has buffered enough data.

No binary audio files were modified by this change.
