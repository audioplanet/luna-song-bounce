# Song Bounce

A LUNA Add On that bounces every song in a session to its own file, **through the main
output** (your main plugins and main fader included), named after the song's marker. It can
also make versions (Mix, Instrumental, A cappella…) and minus-one packages for session players,
and trims each song where its sound fades out.

## Install

1. Download `song-bounce.lunaaddon` from the [latest release](../../releases/latest).
2. Double-click it. LUNA opens and asks to add it.

Or, in LUNA's Add Ons settings, import this repository's address; LUNA installs the latest
release and offers updates. Then open **Add Ons > Windows > Song Bounce**. Needs LUNA 3.1.2 or
later. After installing a new version, restart LUNA: it keeps Add On windows running when they
are closed, so the window title shows which version is loaded.

## Songs

- Put a marker at the start of each song, named after the song.
- **Song end:**
  - **Trim silence below −60 dB** (default): each song ends just after its sound fades below
    that level, plus half a second. Gaps between songs are left out.
  - **Fixed tail:** the song ends a set number of seconds after its last clip.
- A marker named **End** ends the song exactly there, whatever the setting.
- Muted tracks and muted clips don't count. A song never runs into the next marker.
- Tick the songs you want and click **Bounce**: `Song 1.wav`, `Song 2.wav`, …

## Versions

Each version is a set of tracks and buses to mute: *Instrumental* mutes the vocal bus, for
example. Every ticked song comes out in every ticked version, through the main output:
`Song 1 - Mix.wav`, `Song 1 - Instrumental.wav`. With only an unmuted version ticked, files keep
plain names. Versions are kept and work in any session with the same track and bus names.

## Minus-one packages

For a session player: pick their part (one track or bus) and each song gives two files that
start together and have exactly the same length:

- `Song 1 - minus Bass - 125bpm.wav`: the mix through the main output, without the part.
- `Song 1 - Bass - 125bpm.wav`: the part alone, either **raw** from its own channel (its own
  fader and plugins, not the main) or **soloed through the main**.

The tempo in the names is optional. A package can have its own folder.

## Your mix is put back

To mute a channel for a version or package, Song Bounce turns its automation mode Off (mute
automation in Read would unmute it), then puts every mute, solo and automation mode back
exactly as it was. It deselects all tracks while it works, because with LUNA's selection
grouping a mute on one selected track mutes them all, and restores your selection afterwards.
If LUNA closes mid-bounce, a **Restore mutes** banner offers to put things back next time.

## Good to know

- Files are **32-bit float WAV** at the session's sample rate: LUNA's bounce has no format
  option, and LUNA's Mixdown settings can't be set by an Add On.
- Files with the same name in the folder are replaced.
- LUNA doesn't create folders. If the folder is missing, Song Bounce opens the folder dialog
  so you can make it with **New Folder**, and checks every file after it is bounced.
- With a track soloed, only soloed channels end up in the bounces; Song Bounce warns you.

## Develop

Built with [`@uaudio/luna-builder-sdk`](https://github.com/uaudio-labs/luna-builder-sdk).
`logic.js` holds everything that talks to LUNA, without DOM; `main.js` is the window;
`tests/` runs against `Luna.MockEngine` with no LUNA needed.

```sh
npm install
npm test
npx ua-builder serve      # http://localhost:8790/ with LUNA running (trimming needs LUNA's window)
npx ua-builder install    # link into LUNA's Add Ons folder
npx ua-builder pack       # build song-bounce.lunaaddon
```

## License

MIT. See [LICENSE](LICENSE). The bundled `vendor/luna.global.js` is Universal Audio's LUNA
Builder SDK, under its own Apache 2.0 license and supplemental terms.
