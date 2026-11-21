// Runs against Luna.MockEngine: no LUNA needed. `npm test`.
import { describe, expect, it } from 'vitest';
import { Luna } from '@uaudio/luna-builder-sdk';

globalThis.Luna = Luna; // logic.js is a classic script that reads the Luna global
await import('../logic.js');
const L = globalThis.SongLogic;
L.RENDER_POLL_MS = 20; // fast backup checks in tests

const BAR = Luna.WHOLE_NOTE;
const tail2 = (t) => t + 2 * BAR; // a tail of two bars, for the pure tests
const m = (name, bar) => ({ name, tick: bar * BAR });
const c = (from, to) => ({ start: from * BAR, stop: to * BAR });
const brief = (songs) => songs.map((s) => [s.name, s.start / BAR, s.end === null ? null : s.end / BAR, s.reason]);

describe('songs from markers', () => {
  it('ends a song at its last clip plus the tail, leaving out the gap', () => {
    const songs = L.computeSongs([m('Song 1', 0), m('Song 2', 20)], [c(0, 10), c(2, 12), c(20, 30)], tail2);
    expect(brief(songs)).toEqual([
      ['Song 1', 0, 14, 'last-clip'],
      ['Song 2', 20, 32, 'last-clip'],
    ]);
  });

  it('lets an End marker win', () => {
    const songs = L.computeSongs([m('Song 1', 0), m('End', 9), m('Song 2', 20)], [c(0, 10), c(20, 30)], tail2);
    expect(brief(songs)[0]).toEqual(['Song 1', 0, 9, 'end-marker']);
    expect(songs).toHaveLength(2); // End starts nothing
  });

  it('accepts End in any case and with spaces', () => {
    for (const n of ['end', 'END', ' End ']) expect(L.isEndMarker(n)).toBe(true);
    for (const n of ['Ending', 'The End', '']) expect(L.isEndMarker(n)).toBe(false);
  });

  it('cuts the tail at the next marker', () => {
    const songs = L.computeSongs([m('A', 0), m('B', 11)], [c(0, 10), c(11, 12)], tail2);
    expect(brief(songs)[0]).toEqual(['A', 0, 11, 'next-marker']);
  });

  it('ignores the part of a clip that runs into the next song', () => {
    const songs = L.computeSongs([m('A', 0), m('B', 10)], [c(0, 4), c(8, 16)], (t) => t);
    expect(brief(songs)[0]).toEqual(['A', 0, 10, 'next-marker']);
    expect(brief(songs)[1]).toEqual(['B', 10, 16, 'last-clip']);
  });

  it('flags a song with no clips', () => {
    const songs = L.computeSongs([m('Silence', 0), m('Song', 10)], [c(10, 12)], tail2);
    expect(brief(songs)[0]).toEqual(['Silence', 0, null, 'empty']);
  });

  it('ignores music before the first marker and markers in any order', () => {
    const songs = L.computeSongs([m('B', 20), m('A', 10)], [c(0, 5), c(10, 12), c(20, 22)], (t) => t);
    expect(brief(songs)).toEqual([
      ['A', 10, 12, 'last-clip'],
      ['B', 20, 22, 'last-clip'],
    ]);
  });
});

describe('file names', () => {
  it('makes names safe for the file system', () => {
    expect(L.safeFileName('AC/DC: "Live?" <1>')).toBe('AC-DC- -Live-- -1-');
    expect(L.safeFileName('  ..hidden. ')).toBe('hidden');
    expect(L.safeFileName('')).toBe('Untitled');
  });

  it('numbers repeated names', () => {
    const songs = L.computeSongs([m('Take', 0), m('take', 10), m('Take', 20)], [c(0, 1), c(10, 11), c(20, 21)], (t) => t);
    expect(songs.map((s) => s.fileName)).toEqual(['Take.wav', 'take (2).wav', 'Take (3).wav']);
  });

  it('joins folder and file', () => {
    expect(L.joinPath('/a/b/', 'c.wav')).toBe('/a/b/c.wav');
    expect(L.joinPath('/a/b', 'c.wav')).toBe('/a/b/c.wav');
  });
});

async function connected() {
  const engine = new Luna.MockEngine();
  engine.addSession('abc', { name: 'Album', tracks: ['Bass', 'Keys'] });
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  await session.ready();
  return { engine, luna, session };
}

// Finish every running render at once, as a quick offline bounce would.
function autoFinish(engine) {
  const timer = setInterval(() => {
    for (const uid of engine.children('/renders')) {
      if (engine.value(`/renders/${uid}`, 'state') === 'running') engine.finishRender(uid, { state: 'completed' });
    }
  }, 5);
  return () => clearInterval(timer);
}

describe('against the mock engine', () => {
  it('reads songs from markers and clips, skipping muted tracks', async () => {
    const { engine, session } = await connected();
    const bass = session.tracks.items.find((t) => t.name.value === 'Bass');
    const keys = session.tracks.items.find((t) => t.name.value === 'Keys');
    engine.addMidiClip('abc', bass.id, { startTick: 0, stopTick: 8 * BAR });
    engine.addMidiClip('abc', keys.id, { startTick: 20 * BAR, stopTick: 26 * BAR });
    await session.addMarker(0, 'Song 1');
    await session.addMarker(20 * BAR, 'Song 2');
    await engine.settled();
    const songs = await L.songs(session, 0);
    expect(brief(songs)).toEqual([
      ['Song 1', 0, 8, 'last-clip'],
      ['Song 2', 20, 26, 'last-clip'],
    ]);

    await keys.loadStrip();
    await keys.mute.real.set(true);
    await engine.settled();
    expect(brief(await L.songs(session, 0))[1]).toEqual(['Song 2', 20, null, 'empty']);
  });

  it('bounces each song from the main output to its own file, in order', async () => {
    const { engine, session } = await connected();
    const stop = autoFinish(engine);
    try {
      const songs = L.computeSongs([m('Song 1', 0), m('Song 2', 20)], [c(0, 8), c(20, 26)], (t) => t);
      const events = [];
      const results = await L.bounceAll(session, songs, '/tmp/out/', { onEvent: (e) => e.type !== 'progress' && events.push(`${e.type}:${e.song.name}`) });
      expect(events).toEqual(['start:Song 1', 'done:Song 1', 'start:Song 2', 'done:Song 2']);
      expect(results.map((r) => r.path)).toEqual(['/tmp/out/Song 1.wav', '/tmp/out/Song 2.wav']);
      const bounces = engine.requests.filter((r) => r.path.endsWith('/renders/new'));
      expect(bounces).toHaveLength(2);
      expect(JSON.stringify(bounces[0])).toContain(session.master.id);
    } finally {
      stop();
    }
  });

  it('stops after the current song when asked', async () => {
    const { engine, session } = await connected();
    const stop = autoFinish(engine);
    try {
      const songs = L.computeSongs([m('A', 0), m('B', 10), m('C', 20)], [c(0, 1), c(10, 11), c(20, 21)], (t) => t);
      const signal = {};
      const done = [];
      await L.bounceAll(session, songs, '/tmp', {
        signal,
        onEvent: (e) => {
          if (e.type === 'done') {
            done.push(e.song.name);
            signal.stop = true;
          }
        },
      });
      expect(done).toEqual(['A']);
    } finally {
      stop();
    }
  });
});

describe('versions', () => {
  it('cleans stored versions and always has one', () => {
    expect(L.parseVersions(null)).toEqual([{ name: 'Mix', muted: [] }]);
    expect(L.parseVersions([{ name: ' Inst ', muted: ['Vox', 'Vox', 3] }, { name: 'inst' }, { name: '' }])).toEqual([{ name: 'Inst', muted: ['Vox'] }]);
  });

  it('names files after song and version, or keeps plain names for the plain mix alone', () => {
    const song = { fileName: 'Song 1.wav' };
    expect(L.versionFileName(song, { name: 'Instrumental' }, false)).toBe('Song 1 - Instrumental.wav');
    expect(L.versionFileName(song, { name: 'A/B' }, false)).toBe('Song 1 - A-B.wav');
    expect(L.versionFileName(song, { name: 'Mix' }, true)).toBe('Song 1.wav');
  });

  async function versionSession() {
    const { engine, luna, session } = await connected();
    const bus = await session.newBus({ name: 'Vocals' });
    // LUNA's set_automode_on_tracks takes buses too (measured on LUNA 3.1.2); the mock only
    // applies it to tracks, so teach it.
    const names = ['off', 'read', 'write', 'touch', 'latch'];
    engine.overrideCommand('/sessions/abc/set_automode_on_tracks', (data) => {
      for (const id of data?.tracks ?? []) {
        for (const kind of ['tracks', 'buses']) {
          if (engine.has(`/sessions/abc/${kind}/${id}`)) engine.setValue(`/sessions/abc/${kind}/${id}`, 'automation_mode', names[data.automation_mode] ?? 'read');
        }
      }
      return null;
    });
    await engine.settled();
    const byName = (n) => L.mutableChannels(session).find((c) => c.name.value === n);
    return { engine, luna, session, bus, byName };
  }

  it('mutes each version with automation off, bounces, and puts everything back', async () => {
    const { engine, luna, session, byName } = await versionSession();
    const keys = byName('Keys');
    await keys.loadStrip();
    await keys.mute.real.set(true); // already muted by the user: must stay muted
    await engine.settled();
    const stop = autoFinish(engine);
    const seen = [];
    let snapshots = 0;
    try {
      const songs = L.computeSongs([m('Song 1', 0)], [c(0, 4)], (t) => t);
      const versions = [{ name: 'Mix', muted: [] }, { name: 'Instrumental', muted: ['Vocals'] }, { name: 'No Bass', muted: ['Bass', 'Ghost'] }];
      const { results, notRestored } = await L.bounceVersions(luna, session, songs, versions, '/out', {
        onSnapshot: (s) => s && snapshots++,
        onEvent: (e) => {
          if (e.type !== 'start') return;
          seen.push([e.version.name, ...['Bass', 'Keys', 'Vocals'].map((n) => `${n}:${byName(n).mute.on ? 'M' : '-'}${byName(n).automationMode.value === 'off' ? '/off' : ''}`)]);
        },
      });
      expect(results.map((r) => r.path)).toEqual(['/out/Song 1 - Mix.wav', '/out/Song 1 - Instrumental.wav', '/out/Song 1 - No Bass.wav']);
      expect(seen).toEqual([
        ['Mix', 'Bass:-', 'Keys:M', 'Vocals:-'],
        ['Instrumental', 'Bass:-', 'Keys:M', 'Vocals:M/off'],
        ['No Bass', 'Bass:M/off', 'Keys:M', 'Vocals:-'],
      ]);
      expect(notRestored).toEqual([]);
      expect(snapshots).toBe(1);
      for (const n of ['Bass', 'Vocals']) {
        expect(byName(n).mute.on).toBe(false);
        expect(byName(n).automationMode.value).not.toBe('off');
      }
      expect(byName('Keys').mute.on).toBe(true);
    } finally {
      stop();
    }
  });

  it('puts mutes back when a bounce fails', async () => {
    const { engine, luna, session, byName } = await versionSession();
    engine.fail(`/renders/new`, 'device.render_error', 5);
    const songs = L.computeSongs([m('Song 1', 0)], [c(0, 4)], (t) => t);
    const { results, notRestored } = await L.bounceVersions(luna, session, songs, [{ name: 'Inst', muted: ['Vocals'] }], '/out');
    expect(results[0].error).toBeTruthy();
    expect(notRestored).toEqual([]);
    expect(byName('Vocals').mute.on).toBe(false);
  });
});

describe('minus-one packages', () => {
  it('cleans stored packages', () => {
    expect(L.parsePackages([{ part: ' Bass ', partFrom: 'main', bpm: false }, { part: 'Bass' }, { part: '' }, { part: 'Keys' }])).toEqual([
      { part: 'Bass', partFrom: 'main', bpm: false, folder: '' },
      { part: 'Keys', partFrom: 'raw', bpm: true, folder: '' },
    ]);
  });

  async function pkgSession() {
    const { engine, luna, session } = await connected();
    const names = ['off', 'read', 'write', 'touch', 'latch'];
    engine.overrideCommand('/sessions/abc/set_automode_on_tracks', (data) => {
      for (const id of data?.tracks ?? []) {
        for (const kind of ['tracks', 'buses']) {
          if (engine.has(`/sessions/abc/${kind}/${id}`)) engine.setValue(`/sessions/abc/${kind}/${id}`, 'automation_mode', names[data.automation_mode] ?? 'read');
        }
      }
      return null;
    });
    await engine.settled();
    const byName = (n) => L.mutableChannels(session).find((c) => c.name.value === n);
    return { engine, luna, session, byName };
  }

  const state = (ch) => `${ch.mute.on ? 'M' : '-'}${L.soloControl(ch)?.on ? 'S' : '-'}`;

  it('bounces the mix minus the part, then the part raw from its own track, and puts it all back', async () => {
    const { engine, luna, session, byName } = await pkgSession();
    const stop = autoFinish(engine);
    try {
      const songs = L.computeSongs([m('Song 1', 0)], [c(0, 4)], (t) => t);
      const seen = [];
      const { results, notRestored } = await L.runPasses(luna, session, songs, L.packagePasses(session, { part: 'Bass', partFrom: 'raw', bpm: true }), '/out', {
        onEvent: (e) => e.type === 'start' && seen.push(`${e.pass.kind} Bass:${state(byName('Bass'))} Keys:${state(byName('Keys'))}`),
      });
      expect(results.map((r) => r.path)).toEqual(['/out/Song 1 - minus Bass - 120bpm.wav', '/out/Song 1 - Bass - 120bpm.wav']);
      expect(seen).toEqual(['minus Bass:M- Keys:--', 'part Bass:-- Keys:--']);
      const news = engine.requests.filter((r) => r.path.endsWith('/renders/new')).map((r) => JSON.stringify(r));
      expect(news[0]).toContain(session.master.id);
      expect(news[1]).toContain(byName('Bass').id);
      expect(notRestored).toEqual([]);
      expect(state(byName('Bass'))).toBe('--');
    } finally {
      stop();
    }
  });

  it('solos the part through the main when asked, and un-solos it after', async () => {
    const { engine, luna, session, byName } = await pkgSession();
    const stop = autoFinish(engine);
    try {
      const songs = L.computeSongs([m('Song 1', 0)], [c(0, 4)], (t) => t);
      const seen = [];
      const { results } = await L.runPasses(luna, session, songs, L.packagePasses(session, { part: 'Bass', partFrom: 'main', bpm: false, folder: '/for bass' }), '/out', {
        onEvent: (e) => e.type === 'start' && seen.push(`${e.pass.kind} Bass:${state(byName('Bass'))} Keys:${state(byName('Keys'))}`),
      });
      expect(results.map((r) => r.path)).toEqual(['/for bass/Song 1 - minus Bass.wav', '/for bass/Song 1 - Bass.wav']);
      expect(seen).toEqual(['minus Bass:M- Keys:--', 'part Bass:-S Keys:--']);
      const news = engine.requests.filter((r) => r.path.endsWith('/renders/new')).map((r) => JSON.stringify(r));
      expect(news[1]).toContain(session.master.id);
      expect(state(byName('Bass'))).toBe('--');
    } finally {
      stop();
    }
  });

  it('un-solos other channels for a part through the main, and solos them again after', async () => {
    const { engine, luna, session, byName } = await pkgSession();
    const keys = byName('Keys');
    await keys.controls.load();
    await L.soloControl(keys).real.set(true);
    await engine.settled();
    const stop = autoFinish(engine);
    try {
      const songs = L.computeSongs([m('Song 1', 0)], [c(0, 4)], (t) => t);
      const seen = [];
      await L.runPasses(luna, session, songs, [L.packagePasses(session, { part: 'Bass', partFrom: 'main', bpm: false })[1]], '/out', {
        onEvent: (e) => e.type === 'start' && seen.push(`Bass:${state(byName('Bass'))} Keys:${state(byName('Keys'))}`),
      });
      expect(seen).toEqual(['Bass:-S Keys:--']);
      expect(state(keys)).toBe('-S');
    } finally {
      stop();
    }
  });

  it('reports a part that is not in the session', async () => {
    const { luna, session } = await pkgSession();
    const songs = L.computeSongs([m('Song 1', 0)], [c(0, 4)], (t) => t);
    const { results } = await L.runPasses(luna, session, songs, [L.packagePasses(session, { part: 'Tuba', partFrom: 'raw', bpm: false })[1]], '/out');
    expect(results[0].error.message).toContain('Tuba');
  });
});

describe('trimming', () => {
  // A WAV file in memory: `seconds` long at 1000 Hz, stereo, with a loud sample at `loudAt`
  // seconds (or none) and quiet noise at -80 dB elsewhere.
  function wav({ seconds, loudAt, bits = 32, format = 3, rate = 1000 }) {
    const ch = 2;
    const frames = Math.round(seconds * rate);
    const bytes = bits / 8;
    const buf = new ArrayBuffer(44 + frames * ch * bytes);
    const v = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, buf.byteLength - 8, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, format, true); v.setUint16(22, ch, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * ch * bytes, true); v.setUint16(32, ch * bytes, true); v.setUint16(34, bits, true);
    str(36, 'data'); v.setUint32(40, frames * ch * bytes, true);
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < ch; c++) {
        const x = loudAt !== undefined && f === Math.round(loudAt * rate) && c === 1 ? 0.5 : 0.0001;
        const o = 44 + (f * ch + c) * bytes;
        if (format === 3) v.setFloat32(o, x, true);
        else if (bits === 16) v.setInt16(o, Math.round(x * 32767), true);
        else if (bits === 24) { const n = Math.round(x * 8388607); v.setUint8(o, n & 255); v.setUint8(o + 1, (n >> 8) & 255); v.setUint8(o + 2, (n >> 16) & 255); }
      }
    }
    return buf;
  }

  it('reads float, 16-bit and 24-bit WAV files', () => {
    for (const [bits, format] of [[32, 3], [16, 1], [24, 1]]) {
      const w = L.parseWav(wav({ seconds: 2, loudAt: 1.5, bits, format }));
      expect([w.sampleRate, w.channels, w.frames]).toEqual([1000, 2, 2000]);
      expect(L.lastLoudFrame(w, -60)).toBe(1500);
    }
    expect(() => L.parseWav(new ArrayBuffer(20))).toThrow();
  });

  it('ends just after the last sound above the threshold', () => {
    const w = L.parseWav(wav({ seconds: 20, loudAt: 7 }));
    // The file starts 100 s into the session; margin 0.5 s.
    expect(L.trimmedEndSeconds(w, 100, 120, -60)).toBeCloseTo(107.501, 3);
    // Quiet noise at -80 dB counts as silence at -60 but as sound at -90.
    expect(L.trimmedEndSeconds(w, 100, 120, -90)).toBeCloseTo(120, 3);
  });

  it('ends at the start of the window when everything is below the threshold', () => {
    const w = L.parseWav(wav({ seconds: 5 }));
    expect(L.trimmedEndSeconds(w, 10, 15, -60)).toBeCloseTo(10.5, 3);
  });

  it('measures each song once and keeps End-marker songs as they are', async () => {
    const { engine, session } = await connected();
    const stop = autoFinish(engine);
    try {
      // 120 BPM: a bar is 2 s. Song 1's last clip ends at bar 4 (8 s), max tail to bar 14.
      const songs = L.computeSongs([m('Song 1', 0), m('Song 2', 20), m('End', 22)], [c(0, 4), c(20, 21)], (t) => t + 10 * BAR);
      const measured = [];
      const out = await L.trimSongs(session, songs, '/out', {
        analysisPath: (s) => `/out/${s.name}.wav`,
        // The analysis render starts 10 s before the clip ends, i.e. at 0 s here (clamped to
        // the song start); the sound dies 9 s in.
        readWav: async (path) => {
          measured.push(path);
          return L.parseWav(wav({ seconds: 28, loudAt: 9 }));
        },
      });
      expect(measured).toEqual(['/out/Song 1.wav']);
      expect(out[0].reason).toBe('trimmed');
      expect(out[0].end / BAR).toBeCloseTo(9.5005 / 2, 3);
      expect(out[1].reason).toBe('end-marker');
      const news = engine.requests.filter((r) => r.path.endsWith('/renders/new'));
      expect(news).toHaveLength(1);
      expect(JSON.stringify(news[0])).toContain(session.master.id);
    } finally {
      stop();
    }
  });

  it('keeps the full tail when a song cannot be measured', async () => {
    const { engine, session } = await connected();
    const stop = autoFinish(engine);
    try {
      const songs = L.computeSongs([m('Song 1', 0)], [c(0, 4)], (t) => t + 10 * BAR);
      const events = [];
      const out = await L.trimSongs(session, songs, '/out', {
        analysisPath: (s) => `/out/${s.name}.wav`,
        readWav: async () => { throw new Error('nope'); },
        onEvent: (e) => events.push(e.type),
      });
      expect(out[0]).toEqual(songs[0]);
      expect(events).toEqual(['trim-start', 'trim-failed']);
    } finally {
      stop();
    }
  });
});

describe('files LUNA did not write', () => {
  it('fails the song and stops the run instead of reporting it done', async () => {
    const { engine, session } = await connected();
    const stop = autoFinish(engine);
    try {
      const songs = L.computeSongs([m('A', 0), m('B', 10)], [c(0, 1), c(10, 11)], (t) => t);
      const events = [];
      const results = await L.bounceAll(session, songs, '/missing', {
        verify: async () => false,
        onEvent: (e) => e.type !== 'progress' && events.push(`${e.type}:${e.song.name}`),
      });
      expect(events).toEqual(['start:A', 'failed:A', 'stopped:B']);
      expect(results[0].error.code).toBe('not_written');
      expect(results[0].error.message).toContain('does not create folders');
    } finally {
      stop();
    }
  });

  it('measures in the temporary folder on macOS', () => {
    expect(L.measurePath('/Users/me/Music/Exported Files', { name: 'Song: One' })).toBe('/tmp/Song Bounce measuring - Song- One.wav');
  });
});

describe('folders', () => {
  it('asks LUNA whether a folder exists', async () => {
    const answer = (code) => ({ gui: { serveMediaFile: async () => { if (code) throw Object.assign(new Error(code), { code }); return 'url'; } } });
    expect(await L.folderExists(answer('uasrv.invalid_value'), '/a')).toBe(true);
    expect(await L.folderExists(answer('uasrv.filesystem_error'), '/a')).toBe(false);
    expect(await L.folderExists(answer(null), '/a/file.wav')).toBe(false);
    expect(await L.folderExists(answer('uasrv.something_else'), '/a')).toBe(null);
  });

  it('finds the folder a path is in', () => {
    expect(L.parentFolder('/a/b/Exported Files')).toBe('/a/b');
    expect(L.parentFolder('/a/b/')).toBe('/a');
    expect(L.parentFolder('/a')).toBe('/');
  });
});

describe('selection', () => {
  it('deselects tracks while changing mutes and gives the selection back', async () => {
    const { engine, luna, session } = await connected();
    const names = ['off', 'read', 'write', 'touch', 'latch'];
    engine.overrideCommand('/sessions/abc/set_automode_on_tracks', (data) => {
      for (const id of data?.tracks ?? []) if (engine.has(`/sessions/abc/tracks/${id}`)) engine.setValue(`/sessions/abc/tracks/${id}`, 'automation_mode', names[data.automation_mode] ?? 'read');
      return null;
    });
    const ids = session.tracks.items.map((t) => t.id);
    await session.context.load();
    await session.context.select({ trackUids: ids });
    await engine.settled();
    const before = session.context.snapshot().selection_tracks;
    expect(before).toEqual(ids);
    const stop = autoFinish(engine);
    const during = [];
    try {
      const songs = L.computeSongs([m('Song 1', 0)], [c(0, 4)], (t) => t);
      await L.runPasses(luna, session, songs, [{ label: 'No Bass', mute: ['Bass'], solo: null, fileName: () => 'x.wav' }], '/out', {
        onEvent: (e) => e.type === 'start' && during.push(session.context.snapshot().selection_tracks),
      });
    } finally {
      stop();
    }
    await engine.settled();
    expect(during[0] ?? []).toEqual([]);
    expect(session.context.snapshot().selection_tracks).toEqual(before);
  });
});
