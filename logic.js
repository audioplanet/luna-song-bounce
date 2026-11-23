// Song Bounce: logic with no DOM, so tests can exercise it against Luna.MockEngine.
//
// Two ways to find songs:
// - Whole song (the default): the session is one song, from its first clip to its last clip
//   plus a tail, named after the session. Markers are ignored, so section markers (Verse,
//   Chorus…) don't split it.
// - Song per marker, for album sessions: a marker with a name starts a song; a marker named
//   "End" ends the song before it. A song with no End marker ends where its last clip ends,
//   plus a tail for reverb, and never later than the next marker.
// Each song is bounced from the main output (main plugins and main fader included) to its own
// file.

const SongLogic = {
  /** Shown in the window, so it is clear which version LUNA has loaded. Keep in step with manifest.json. */
  VERSION: '0.5.0',
  DEFAULT_TAIL_SECONDS: 4,
  ADD_ON_ID: 'com.audioplanet.song_bounce',
  /** Trimming: how far past the last clip to look for the end of the sound, at most. */
  TRIM_MAX_SECONDS: 20,
  /** Trimming: how much of the song before its last clip ends is rendered, so reverbs are full. */
  TRIM_PREROLL_SECONDS: 10,
  /** Trimming: kept after the last sound above the threshold, so the very end of a fade stays. */
  TRIM_MARGIN_SECONDS: 0.5,
  DEFAULT_TRIM_DB: -60,

  /** True for a marker that ends a song instead of starting one. */
  isEndMarker(name) {
    return /^\s*end\s*$/i.test(name ?? '');
  },

  /** A file name safe on macOS and Windows, from a marker name. */
  safeFileName(name) {
    let n = String(name ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .replace(/[. ]+$/, '');
    if (!n) n = 'Untitled';
    return n.slice(0, 120);
  },

  /**
   * Work out the songs. Pure: no engine access, so it is easy to test.
   * - `markers`: `[{ name, tick }]`, any order.
   * - `clips`: `[{ start, stop }]` in ticks: every clip that plays (muted ones left out).
   * - `addTail(tick)`: the tick that is the tail length after `tick`.
   * Returns `[{ name, fileName, start, end, reason }]` in timeline order, where `reason` is
   * `'end-marker'`, `'last-clip'` (last clip plus tail), `'next-marker'` (tail cut short by
   * the next marker) or `'empty'` (no clips: nothing to bounce; `end` is null).
   */
  computeSongs(markers, clips, addTail) {
    const sorted = [...markers].sort((a, b) => a.tick - b.tick);
    const songs = [];
    sorted.forEach((m, i) => {
      if (SongLogic.isEndMarker(m.name)) return;
      const next = sorted[i + 1];
      const limit = next ? next.tick : Infinity;
      const base = { name: (m.name ?? '').trim() || 'Untitled', start: m.tick };
      if (next && SongLogic.isEndMarker(next.name)) {
        songs.push({ ...base, end: next.tick, reason: 'end-marker' });
        return;
      }
      let last = -Infinity;
      for (const c of clips) {
        if (c.stop > m.tick && c.start < limit) last = Math.max(last, Math.min(c.stop, limit));
      }
      if (last === -Infinity) {
        songs.push({ ...base, end: null, reason: 'empty' });
        return;
      }
      const withTail = addTail(last);
      if (withTail >= limit) songs.push({ ...base, end: limit, lastClip: last, reason: 'next-marker' });
      else songs.push({ ...base, end: withTail, lastClip: last, reason: 'last-clip' });
    });
    // File names: safe, and unique ("Song", "Song (2)", ...), compared without case.
    const used = new Map();
    for (const s of songs) {
      const stem = SongLogic.safeFileName(s.name);
      const key = stem.toLowerCase();
      const n = (used.get(key) ?? 0) + 1;
      used.set(key, n);
      s.fileName = `${n === 1 ? stem : `${stem} (${n})`}.wav`;
    }
    return songs;
  },

  /**
   * The whole session as one song: from the first clip to the last clip plus the tail, named
   * `name` (the session's name). Pure, like computeSongs, and returns the same shape: one song,
   * or one `'empty'` song when nothing plays.
   */
  computeWholeSong(name, clips, addTail) {
    const song = { name: String(name ?? '').trim() || 'Untitled' };
    song.fileName = `${SongLogic.safeFileName(song.name)}.wav`;
    if (!clips.length) return [{ ...song, start: 0, end: null, reason: 'empty' }];
    const start = Math.min(...clips.map((c) => c.start));
    const last = Math.max(...clips.map((c) => c.stop));
    return [{ ...song, start, end: addTail(last), lastClip: last, reason: 'last-clip' }];
  },

  /** Markers as `[{ name, tick }]`. */
  async readMarkers(session) {
    await session.markers.load();
    await session.markers.membersReady();
    return session.markers.sorted.map((m) => ({ name: m.name.value ?? '', tick: m.location.value ?? 0 }));
  },

  /**
   * Every clip that plays, as `[{ start, stop }]`: clips on the active playlist of each audio
   * and instrument track, skipping muted tracks and muted clips.
   */
  async readClips(session) {
    const spans = [];
    for (const track of session.visibleTracks) {
      const type = track.trackType.value;
      if (type !== 'audio' && type !== 'instrument') continue;
      await track.loadStrip();
      if (track.mute.on) continue;
      const playlist = session.playlists.byId(track.playlistUid.value);
      if (!playlist) continue;
      await playlist.clips.load();
      await playlist.clips.membersReady();
      for (const c of playlist.clips.items) {
        if (c.muted.value) continue;
        const start = c.start.value;
        const stop = c.stop.value;
        if (typeof start === 'number' && typeof stop === 'number' && stop > start) spans.push({ start, stop });
      }
    }
    return spans;
  },

  /** A function adding `seconds` of real time to a tick, through the tempo map. */
  tailAdder(session, seconds) {
    const tl = session.musical.timeline;
    return (tick) => {
      try {
        return tl.tickAtSeconds(tl.seconds(tick) + seconds);
      } catch {
        // Tempo map not loaded yet: fall back to 120 BPM.
        return tick + Luna.secondsToTicks(seconds, 120);
      }
    };
  },

  /** The songs of a session, read fresh from LUNA. `mode` is `'markers'` or `'whole'`. */
  async songs(session, tailSeconds, mode = 'markers') {
    await session.playlists.load();
    const addTail = SongLogic.tailAdder(session, tailSeconds);
    if (mode === 'whole') return SongLogic.computeWholeSong(session.name.value, await SongLogic.readClips(session), addTail);
    const [markers, clips] = await Promise.all([SongLogic.readMarkers(session), SongLogic.readClips(session)]);
    return SongLogic.computeSongs(markers, clips, addTail);
  },

  /** LUNA's export folder for the session ("…/Exported Files"), or undefined. */
  async exportFolder(luna, session) {
    try {
      const r = await luna.raw.get(`/sessions/${session.uid}`, { propfilter: 'export_folder_path', children: false, commands: false, flatvalue: true });
      const p = r?.properties?.export_folder_path ?? r?.export_folder_path;
      return typeof p === 'string' && p ? p : undefined;
    } catch {
      return undefined;
    }
  },

  /** `folder` + `/` + `file`, without doubling the slash. */
  joinPath(folder, file) {
    return `${folder.replace(/[\\/]+$/, '')}/${file}`;
  },

  /**
   * Bounce one song to `folder/fileName`: from the main output, or from `song.channelUid`
   * (a track or bus on its own) when set; `song.folder` overrides `folder`. `onProgress(0..1)` follows
   * the render; `signal.render` is set so a caller can abort it. Resolves to the path.
   */
  async bounceSong(session, song, folder, { onProgress, signal, verify } = {}) {
    const path = SongLogic.joinPath(song.folder || folder, song.fileName);
    const { render } = await session.bounce({
      channelUids: [song.channelUid ?? session.master.id],
      name: song.name,
      outputPaths: [path],
      range: { startTick: song.start, stopTick: song.end },
    });
    if (signal) signal.render = render;
    const off = onProgress ? render.progress.onChange(() => onProgress(render.progress.value ?? 0)) : null;
    try {
      await SongLogic.waitForRender(render);
    } finally {
      off?.();
      if (signal) signal.render = null;
    }
    // LUNA reports a bounce finished even when it could not write the file (a folder that
    // does not exist, for one), so check the file is really there when we can.
    if (verify && !(await SongLogic.verifyFile(verify, path))) {
      throw Object.assign(new Error(`LUNA did not write ${song.fileName}. Check the folder exists: LUNA does not create folders.`), { code: 'not_written' });
    }
    onProgress?.(1);
    return path;
  },

  /**
   * Whether a folder exists, asked through LUNA (the page cannot look at the disk): true,
   * false, or null when LUNA cannot tell. LUNA refuses to serve a folder (`invalid_value`)
   * and reports a path with nothing there as `filesystem_error`.
   */
  async folderExists(luna, path) {
    try {
      await luna.gui.serveMediaFile(SongLogic.ADD_ON_ID, path);
      return false; // a file, not a folder
    } catch (e) {
      if (e?.code === 'uasrv.invalid_value') return true;
      if (e?.code === 'uasrv.filesystem_error') return false;
      return null;
    }
  },

  /** The folder a path is in ("/a/b/c" -> "/a/b"). */
  parentFolder(path) {
    const i = path.replace(/[\\/]+$/, '').lastIndexOf('/');
    return i > 0 ? path.slice(0, i) : '/';
  },

  /** `verify(path)` with a few retries, for a file system that is slow to show a new file. */
  async verifyFile(verify, path, tries = 4) {
    for (let i = 0; i < tries; i++) {
      if (await verify(path)) return true;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
    return false;
  },

  /**
   * Where measuring renders go: the system's temporary folder on macOS (always there, local,
   * and out of the user's folders), else next to the songs.
   */
  measurePath(folder, song) {
    const name = `Song Bounce measuring - ${SongLogic.safeFileName(song.name)}.wav`;
    return folder.startsWith('/') ? `/tmp/${name}` : SongLogic.joinPath(folder, name);
  },

  /** How often to ask LUNA directly whether a render has finished, in case a push was missed. */
  RENDER_POLL_MS: 2000,

  /**
   * Resolve when a render has completed; reject when it was aborted or failed. Besides the
   * pushes `render.done()` follows, LUNA is asked again every RENDER_POLL_MS: a short offline
   * render can finish, or be dropped, before its last push is seen. A render that is gone
   * finished: LUNA drops a render only once it has settled, and its file is written.
   */
  waitForRender(render) {
    return new Promise((resolve, reject) => {
      let over = false;
      const end = (fn, v) => {
        if (over) return;
        over = true;
        clearInterval(timer);
        fn(v);
      };
      const check = () => {
        const s = render.state.value;
        if (s === 'completed') end(resolve);
        else if (s === 'aborted' || s === 'failed') {
          const msg = render.errorMessage.value;
          end(reject, Object.assign(new Error(`bounce ${s}${msg ? `: ${msg}` : ''}`), { code: s }));
        }
      };
      render.done(6 * 60 * 60 * 1000).then(
        () => end(resolve),
        (e) => (e?.code === 'removed' ? end(resolve) : end(reject, e)),
      );
      const timer = setInterval(async () => {
        try {
          await render.reload();
          check();
        } catch {
          end(resolve); // the node is gone: the render settled and was dropped
        }
      }, SongLogic.RENDER_POLL_MS);
      check();
    });
  },

  // ---- versions: mute sets rendered through the main output ----

  /** The version every list starts with: nothing muted. */
  defaultVersions() {
    return [{ name: 'Mix', muted: [] }];
  },

  /** Clean a stored list of versions: names unique and non-empty, muted names as strings. */
  parseVersions(value) {
    const out = [];
    const seen = new Set();
    for (const v of Array.isArray(value) ? value : []) {
      const name = String(v?.name ?? '').trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      const muted = [...new Set((Array.isArray(v.muted) ? v.muted : []).filter((n) => typeof n === 'string' && n.trim()))];
      out.push({ name, muted });
    }
    return out.length ? out : SongLogic.defaultVersions();
  },

  /**
   * The channels a version can mute, in LUNA's order: audio, instrument and MIDI tracks, then
   * aux buses and folders. The master, cue buses and LUNA's own tracks are left out.
   */
  mutableChannels(session) {
    const tracks = session.visibleTracks.filter((t) => ['audio', 'instrument', 'midi_matrix'].includes(t.trackType.value));
    const buses = session.buses.items.filter((b) => b.busType.value === 'aux');
    return [...tracks, ...buses];
  },

  /** Channels of the session named in `names`; `missing` lists names no channel has. */
  resolveChannels(session, names) {
    const all = SongLogic.mutableChannels(session);
    const channels = [];
    const missing = [];
    for (const n of names) {
      const hit = all.filter((c) => (c.name.value ?? '').trim() === n.trim());
      if (hit.length) channels.push(...hit);
      else missing.push(n);
    }
    return { channels: [...new Set(channels)], missing };
  },

  /** The file for a song in a version. `plain` keeps the song's own name ("Song.wav"). */
  versionFileName(song, version, plain) {
    if (plain) return song.fileName;
    return `${song.fileName.replace(/\.wav$/i, '')} - ${SongLogic.safeFileName(version.name)}.wav`;
  },

  /** Set a track's or bus's automation mode (LUNA's command takes buses too). */
  async setAutomationMode(luna, session, channel, mode) {
    await luna.raw.post(`/sessions/${session.uid}/set_automode_on_tracks`, {
      uid: session.uid,
      tracks: [channel.id],
      automation_mode: Luna.automationModeOrdinal(mode),
    });
  },

  // ---- passes: one mix state, bounced for every song ----
  //
  // A pass is `{ label, mute: [names], open: [names], solo: [names] | null, channelName,
  // fileName(song), folder }`. `mute` channels are muted with automation off; `open` channels
  // are unmuted; with `solo`, exactly those channels are soloed; `channelName` bounces that
  // channel on its own instead of the main output. Versions and minus-one packages are both
  // lists of passes, so they share one way of changing the mix and putting it back.

  /** The solo control of a track or bus (buses have it in their strip controls). */
  soloControl(ch) {
    return ch.solo ?? ch.controls.items.find((c) => c.id === 'solo');
  },

  /** `{ [channelId]: { name, muted, mode, solo } }` for the channels given, as they are now. */
  async snapshot(channels) {
    const snap = {};
    for (const ch of channels) {
      await ch.loadStrip();
      await ch.controls.load();
      await ch.controls.membersReady();
      snap[ch.id] = {
        name: ch.name.value ?? ch.id,
        muted: !!ch.mute.on,
        mode: ch.automationMode.value ?? 'read',
        solo: !!SongLogic.soloControl(ch)?.on,
      };
    }
    return snap;
  },

  channelById(session, id) {
    return session.tracks.byId(id) ?? session.buses.byId(id);
  },

  /** What a pass wants of each channel in `snap`: `{ mute, mode, solo }`. */
  passTargets(session, pass, snap) {
    const ids = (names) => new Set(SongLogic.resolveChannels(session, names ?? []).channels.map((c) => c.id));
    const mute = ids(pass.mute);
    const open = ids(pass.open);
    const solo = pass.solo ? ids(pass.solo) : null;
    const out = {};
    for (const [id, was] of Object.entries(snap)) {
      if (mute.has(id)) out[id] = { mute: true, mode: 'off' };
      else if (open.has(id)) out[id] = { mute: false, mode: was.mode };
      else out[id] = { mute: was.muted, mode: was.mode };
      out[id].solo = solo ? solo.has(id) : was.solo;
    }
    return out;
  },

  /** Set channels to `targets` in one undo step; resolve to the names that did not follow. */
  async setChannels(luna, session, targets, label) {
    const channels = Object.keys(targets).map((id) => SongLogic.channelById(session, id)).filter(Boolean);
    const matches = (ch) => {
      const t = targets[ch.id];
      return !!ch.mute.on === t.mute && ch.automationMode.value === t.mode && !!SongLogic.soloControl(ch)?.on === t.solo;
    };
    await session.transaction(label, async () => {
      for (const ch of channels) {
        const t = targets[ch.id];
        try {
          // Automation off before muting, and back on after unmuting, so Read automation
          // never fights the switch.
          if (t.mode === 'off' && ch.automationMode.value !== 'off') await SongLogic.setAutomationMode(luna, session, ch, 'off');
          if (!!ch.mute.on !== t.mute) await ch.mute.real.set(t.mute);
          if (t.mode !== 'off' && ch.automationMode.value !== t.mode) await SongLogic.setAutomationMode(luna, session, ch, t.mode);
          const solo = SongLogic.soloControl(ch);
          if (solo && !!solo.on !== t.solo) await solo.real.set(t.solo);
        } catch {
          /* reported below */
        }
      }
    });
    await SongLogic.waitFor(() => channels.every(matches));
    return channels.filter((ch) => !matches(ch)).map((ch) => ch.name.value ?? ch.id);
  },

  /**
   * Run `fn` with no tracks selected, then give the user's selection back. With LUNA's
   * selection grouping on, muting or soloing a selected track does the same to every selected
   * track (measured on LUNA 3.1.2: muting one of 38 selected tracks muted all 38), so every
   * mute and solo change happens with nothing selected.
   */
  async withNothingSelected(session, fn) {
    const ctx = session.context;
    await ctx.load().catch(() => {});
    const saved = ctx.snapshot();
    await ctx.select({ trackUids: [], playlistUids: [] });
    try {
      return await fn();
    } finally {
      await ctx.restore(saved).catch(() => {});
    }
  },

  /** `restore`, with nothing selected: for putting a crashed run's mutes back. */
  async restoreSafely(luna, session, snap) {
    return SongLogic.withNothingSelected(session, () => SongLogic.restore(luna, session, snap));
  },

  /** Put every channel in `snap` back as it was. Resolves to the names that would not go back. */
  async restore(luna, session, snap) {
    const targets = {};
    for (const [id, was] of Object.entries(snap)) targets[id] = { mute: was.muted, mode: was.mode, solo: !!was.solo };
    return SongLogic.setChannels(luna, session, targets, 'Song Bounce: restore mutes');
  },

  /** Poll `test` until it is true or `ms` pass. */
  async waitFor(test, ms = 3000) {
    const until = Date.now() + ms;
    for (;;) {
      if (test()) return true;
      if (Date.now() > until) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
  },

  /** Names of tracks and buses that are soloed, which would change every main-output bounce. */
  async soloed(session) {
    const out = [];
    for (const ch of SongLogic.mutableChannels(session)) {
      await ch.controls.load();
      await ch.controls.membersReady();
      if (SongLogic.soloControl(ch)?.on) out.push(ch.name.value ?? ch.id);
    }
    return out;
  },

  /** The passes for a list of versions. */
  versionPasses(versions) {
    const plain = versions.length === 1 && versions[0].muted.length === 0;
    return versions.map((v) => ({
      label: v.name,
      kind: 'version',
      mute: v.muted,
      solo: null,
      fileName: (song) => SongLogic.versionFileName(song, v, plain),
    }));
  },

  /**
   * Run passes: for each, set the mix, then bounce every song. Everything is put back
   * afterwards whatever happens. `onSnapshot(snap)` is called before anything changes and
   * `onSnapshot(null)` once restored, so a caller can keep it somewhere that survives a crash.
   * Events are bounceAll's with `pass` added, plus `{ type: 'pass', pass }` as each starts.
   */
  async runPasses(luna, session, songs, passes, folder, options = {}) {
    return SongLogic.withNothingSelected(session, () => SongLogic.runPassesNow(luna, session, songs, passes, folder, options));
  },

  async runPassesNow(luna, session, songs, passes, folder, { onEvent = () => {}, signal = {}, onSnapshot = () => {}, verify } = {}) {
    const names = [...new Set(passes.flatMap((p) => [...(p.mute ?? []), ...(p.open ?? []), ...(p.solo ?? [])]))];
    let touched = SongLogic.resolveChannels(session, names).channels;
    // Soloing one channel means un-soloing the rest, so every channel's solo is recorded.
    if (passes.some((p) => p.solo)) touched = [...new Set([...touched, ...SongLogic.mutableChannels(session)])];
    const snap = await SongLogic.snapshot(touched);
    onSnapshot(snap);
    const results = [];
    let notRestored = [];
    try {
      for (const pass of passes) {
        if (signal.stop) break;
        onEvent({ type: 'pass', pass });
        const fail = (error) => {
          for (const song of songs) {
            results.push({ song, pass, error });
            onEvent({ type: 'failed', song, pass, error });
          }
        };
        let channelUid;
        if (pass.channelName) {
          const ch = SongLogic.resolveChannels(session, [pass.channelName]).channels[0];
          if (!ch) {
            fail(new Error(`${pass.channelName} is not in this session`));
            continue;
          }
          channelUid = ch.id;
        }
        const stuck = await SongLogic.setChannels(luna, session, SongLogic.passTargets(session, pass, snap), `Song Bounce: ${pass.label}`);
        if (stuck.length) {
          fail(new Error(`could not set ${stuck.join(', ')}`));
          continue;
        }
        const items = songs.map((s) => ({ ...s, fileName: pass.fileName(s), channelUid, folder: pass.folder }));
        const r = await SongLogic.bounceAll(session, items, folder, { signal, verify, onEvent: (e) => onEvent({ ...e, pass }) });
        results.push(...r.map((x) => ({ ...x, pass })));
      }
    } finally {
      notRestored = await SongLogic.restore(luna, session, snap);
      if (!notRestored.length) onSnapshot(null);
    }
    return { results, notRestored };
  },

  /** Every song in every version. */
  async bounceVersions(luna, session, songs, versions, folder, options = {}) {
    const byLabel = (pass) => pass && versions.find((v) => v.name === pass.label);
    const out = await SongLogic.runPasses(luna, session, songs, SongLogic.versionPasses(versions), folder, {
      ...options,
      onEvent: (e) => options.onEvent?.({ ...e, version: byLabel(e.pass) }),
    });
    return { results: out.results.map((r) => ({ ...r, version: byLabel(r.pass) })), notRestored: out.notRestored };
  },

  // ---- trimming: end each song where its sound fades out ----
  //
  // An Add On cannot edit files, so trimming is measured, then bounced: the end of the song is
  // rendered from the main output (from a little before its last clip, so reverbs are full, up
  // to TRIM_MAX_SECONDS after it), the file is read back through LUNA, and the song's end is set
  // just after the last sound above the threshold. It is measured once, from the mix as the user
  // left it, so every version and package of a song has the same length.

  /**
   * Read a WAV file's samples: `{ sampleRate, channels, frames, data }`, `data` a Float32Array
   * of interleaved samples in -1..1. Handles 16, 24 and 32-bit integer and 32-bit float.
   */
  parseWav(buffer) {
    const v = new DataView(buffer);
    const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    if (buffer.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
    let fmt = null;
    let dataOff = -1;
    let dataLen = 0;
    for (let o = 12; o + 8 <= buffer.byteLength; ) {
      const id = tag(o);
      const len = v.getUint32(o + 4, true);
      if (id === 'fmt ') {
        let format = v.getUint16(o + 8, true);
        if (format === 0xfffe && len >= 26) format = v.getUint16(o + 32, true); // WAVE_FORMAT_EXTENSIBLE
        fmt = { format, channels: v.getUint16(o + 10, true), sampleRate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
      } else if (id === 'data') {
        dataOff = o + 8;
        dataLen = Math.min(len, buffer.byteLength - dataOff);
      }
      o += 8 + len + (len & 1);
    }
    if (!fmt || dataOff < 0) throw new Error('WAV file without fmt or data');
    const bytes = fmt.bits / 8;
    const n = Math.floor(dataLen / bytes);
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const o = dataOff + i * bytes;
      if (fmt.format === 3 && fmt.bits === 32) data[i] = v.getFloat32(o, true);
      else if (fmt.format === 1 && fmt.bits === 16) data[i] = v.getInt16(o, true) / 32768;
      else if (fmt.format === 1 && fmt.bits === 24) data[i] = ((v.getUint8(o + 2) << 24) | (v.getUint8(o + 1) << 16) | (v.getUint8(o) << 8)) / 2147483648;
      else if (fmt.format === 1 && fmt.bits === 32) data[i] = v.getInt32(o, true) / 2147483648;
      else throw new Error(`unsupported WAV format ${fmt.format}/${fmt.bits}-bit`);
    }
    return { sampleRate: fmt.sampleRate, channels: fmt.channels, frames: Math.floor(n / fmt.channels), data };
  },

  /** The last frame with any channel at or above `thresholdDb` (dBFS), or -1 if none is. */
  lastLoudFrame(wav, thresholdDb) {
    const limit = Math.pow(10, thresholdDb / 20);
    for (let i = wav.data.length - 1; i >= 0; i--) {
      if (Math.abs(wav.data[i]) >= limit) return Math.floor(i / wav.channels);
    }
    return -1;
  },

  /**
   * Where a song should end, in seconds, given the analysis file that starts at `startSeconds`:
   * just after its last sound above `thresholdDb`, plus TRIM_MARGIN_SECONDS. Never before
   * `startSeconds` and never after `maxSeconds`.
   */
  trimmedEndSeconds(wav, startSeconds, maxSeconds, thresholdDb) {
    const last = SongLogic.lastLoudFrame(wav, thresholdDb);
    const sound = last < 0 ? 0 : (last + 1) / wav.sampleRate;
    return Math.min(maxSeconds, startSeconds + sound + SongLogic.TRIM_MARGIN_SECONDS);
  },

  /** Read a file LUNA wrote, through LUNA (the page cannot open paths itself). */
  async readWav(luna, path) {
    const url = await luna.gui.serveMediaFile(SongLogic.ADD_ON_ID, path);
    const buffer = await new Promise((resolve, reject) => {
      // XMLHttpRequest, not fetch: on Windows LUNA serves file:/// URLs, which fetch refuses.
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.responseType = 'arraybuffer';
      xhr.onload = () => (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300) ? resolve(xhr.response) : reject(new Error(`could not read ${path} (${xhr.status})`)));
      xhr.onerror = () => reject(new Error(`could not read ${path}`));
      xhr.send();
    });
    return SongLogic.parseWav(buffer);
  },

  /** True for a song whose end trimming can move (an End marker always wins). */
  canTrim(song) {
    return (song.reason === 'last-clip' || song.reason === 'next-marker') && typeof song.lastClip === 'number';
  },

  /**
   * Trim each song that can be trimmed. `songs` must have been computed with a tail of
   * TRIM_MAX_SECONDS. Each measuring render is written to `analysisPath(song)` (by default the
   * system's temporary folder). `readWav(path)` reads it back (injectable for tests). Resolves to the songs with new ends; a song that could not be measured keeps its
   * full tail and is reported through `onEvent({ type: 'trim-failed', song, error })`.
   */
  async trimSongs(session, songs, folder, { analysisPath = (song) => SongLogic.measurePath(folder, song), readWav, thresholdDb = SongLogic.DEFAULT_TRIM_DB, onEvent = () => {}, signal = {} }) {
    const tl = session.musical.timeline;
    const out = [];
    for (const song of songs) {
      if (signal.stop || !SongLogic.canTrim(song)) {
        out.push(song);
        continue;
      }
      try {
        const clipEnd = tl.seconds(song.lastClip);
        const startSeconds = Math.max(tl.seconds(song.start), clipEnd - SongLogic.TRIM_PREROLL_SECONDS);
        const maxSeconds = tl.seconds(song.end);
        const start = tl.tickAtSeconds(startSeconds);
        const measure = analysisPath(song);
        const cut = measure.lastIndexOf('/');
        onEvent({ type: 'trim-start', song });
        const path = await SongLogic.bounceSong(session, { name: `${song.name} (measuring)`, start, end: song.end, fileName: measure.slice(cut + 1), folder: measure.slice(0, cut) }, folder, { signal });
        const wav = await readWav(path);
        const endSeconds = SongLogic.trimmedEndSeconds(wav, startSeconds, maxSeconds, thresholdDb);
        const end = Math.max(song.start + 1, Math.min(song.end, tl.tickAtSeconds(endSeconds)));
        const trimmed = { ...song, end, reason: 'trimmed', tailSeconds: Math.max(0, endSeconds - clipEnd) };
        out.push(trimmed);
        onEvent({ type: 'trimmed', song: trimmed });
      } catch (error) {
        out.push(song);
        onEvent({ type: 'trim-failed', song, error });
      }
    }
    return out;
  },

  // ---- minus-one packages ----

  /** Clean stored packages: `{ part, partFrom: 'raw' | 'main', bpm, folder }`, one per part. */
  parsePackages(value) {
    const out = [];
    const seen = new Set();
    for (const p of Array.isArray(value) ? value : []) {
      const part = String(p?.part ?? '').trim();
      if (!part || seen.has(part)) continue;
      seen.add(part);
      out.push({ part, partFrom: p.partFrom === 'main' ? 'main' : 'raw', bpm: p.bpm !== false, folder: typeof p.folder === 'string' ? p.folder : '' });
    }
    return out;
  },

  /** " - 120bpm" (or " - 92.5bpm") for the tempo where a song starts, or '' when unknown. */
  bpmSuffix(session, song) {
    try {
      const bpm = session.musical.timeline.tempoAt(song.start);
      if (!Number.isFinite(bpm) || bpm <= 0) return '';
      return ` - ${String(Math.round(bpm * 100) / 100)}bpm`;
    } catch {
      return '';
    }
  },

  /**
   * The two passes of a package: the main output with the part muted, and the part alone,
   * either raw from its own channel or soloed through the main output. Both cover the same
   * range, so the files line up sample for sample.
   */
  packagePasses(session, pkg) {
    const stem = (song) => song.fileName.replace(/\.wav$/i, '');
    const part = SongLogic.safeFileName(pkg.part);
    const bpm = (song) => (pkg.bpm ? SongLogic.bpmSuffix(session, song) : '');
    const folder = pkg.folder || undefined;
    return [
      {
        label: `minus ${pkg.part}`,
        kind: 'minus',
        mute: [pkg.part],
        solo: null,
        folder,
        fileName: (song) => `${stem(song)} - minus ${part}${bpm(song)}.wav`,
      },
      {
        label: `${pkg.part} alone`,
        kind: 'part',
        open: [pkg.part],
        solo: pkg.partFrom === 'main' ? [pkg.part] : null,
        channelName: pkg.partFrom === 'raw' ? pkg.part : undefined,
        folder,
        fileName: (song) => `${stem(song)} - ${part}${bpm(song)}.wav`,
      },
    ];
  },

  /**
   * Bounce songs one after another. `onEvent({ type, song, index, path, error, progress })`
   * reports `start`, `progress`, `done`, `failed` and `stopped`. `signal.stop = true` stops
   * after the current song; `signal.render.abort()` stops the current one too.
   */
  async bounceAll(session, songs, folder, { onEvent = () => {}, signal = {}, verify } = {}) {
    const results = [];
    for (let index = 0; index < songs.length; index++) {
      const song = songs[index];
      if (signal.stop) {
        onEvent({ type: 'stopped', song, index });
        break;
      }
      onEvent({ type: 'start', song, index });
      try {
        const path = await SongLogic.bounceSong(session, song, folder, {
          signal,
          verify,
          onProgress: (progress) => onEvent({ type: 'progress', song, index, progress }),
        });
        results.push({ song, path });
        onEvent({ type: 'done', song, index, path });
      } catch (error) {
        results.push({ song, error });
        onEvent({ type: 'failed', song, index, error });
        // A file LUNA could not write means the next ones will not be written either.
        if (error?.code === 'not_written') {
          signal.stop = true;
          continue; // the next turn reports the rest as stopped
        }
        if (signal.stop) break;
      }
    }
    return results;
  },
};

globalThis.SongLogic = SongLogic;
