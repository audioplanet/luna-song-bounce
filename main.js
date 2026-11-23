// Song Bounce: the window. Connects to LUNA, follows the focused session, lists the songs
// and versions, and bounces every ticked song in every ticked version. Engine work is in
// logic.js.

const $ = (id) => document.getElementById(id);
const S = SongLogic;
const STORE = 'com.audioplanet.song_bounce';

let luna;
let session = null;
let songs = [];
const unticked = new Set(); // song names the user unticked, kept across refreshes
const status = new Map(); // `${song}|${version}` -> { kind: 'progress'|'ok'|'err'|'wait', progress }
let versions = S.defaultVersions();
let versionOff = new Set(); // version names not ticked
let packages = []; // minus-one packages
let packageOff = new Set(); // parts not ticked
let editing = null; // index of the version being edited, or -1 for a new one
let folder = '';
let bouncing = null; // { signal } while a run is going
let releases = [];

// ---- storage ----

function read(key, fallback) {
  try {
    const v = localStorage.getItem(`${STORE}.${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(`${STORE}.${key}`);
    else localStorage.setItem(`${STORE}.${key}`, JSON.stringify(value));
  } catch {
    /* storage unavailable: settings last until the window closes */
  }
}
function saveVersions() {
  write('versions', versions);
  write('versionsOff', [...versionOff]);
}
function savePackages() {
  write('packages', packages);
  write('packagesOff', [...packageOff]);
}

// ---- helpers ----

function log(text, isError = false) {
  const line = document.createElement('div');
  if (isError) line.className = 'err';
  line.textContent = `${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}  ${text}`;
  $('log').prepend(line);
  while ($('log').childElementCount > 150) $('log').lastChild.remove();
}
function mode() {
  return $('mode').value === 'markers' ? 'markers' : 'whole';
}
const MODE_HOW = {
  whole: 'One file named after the session, from the first clip to the end. Markers are ignored.',
  markers: 'One file per named marker, for album sessions. A marker named “End” ends a song.',
};
function tailSeconds() {
  const v = parseFloat($('tail').value);
  return Number.isFinite(v) && v >= 0 ? Math.min(v, 60) : S.DEFAULT_TAIL_SECONDS;
}
function fmtLength(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '–';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const trimming = () => $('endMode').value === 'trim';
function trimDb() {
  const v = parseFloat($('trimDb').value);
  return Number.isFinite(v) ? Math.max(-120, Math.min(-20, v)) : S.DEFAULT_TRIM_DB;
}
const HOW = {
  trimmed: 'ends where the sound fades out',
  'last-clip': 'ends after its last clip + tail',
  'next-marker': 'ends at the next marker',
  'end-marker': 'ends at its End marker',
  empty: 'no clips: nothing to bounce',
};
const bounceableSongs = () => songs.filter((s) => s.reason !== 'empty' && !unticked.has(s.name));
const tickedVersions = () => versions.filter((v) => !versionOff.has(v.name));
const tickedPackages = () => packages.filter((p) => !packageOff.has(p.part));
/** Everything one Bounce click makes: the ticked versions, then each ticked package's two passes. */
const currentPasses = () => [
  ...S.versionPasses(tickedVersions()),
  ...(session ? tickedPackages().flatMap((p) => S.packagePasses(session, p)) : []),
];
const key = (song, pass) => `${song.name}|${pass.label}`;

// ---- versions ----

function renderVersions() {
  const root = $('versions');
  root.innerHTML = '';
  versions.forEach((v, i) => {
    const row = document.createElement('div');
    row.className = 'version';
    row.innerHTML = `<input type="checkbox"><span class="vname"></span><span class="vmutes"></span><button class="edit">Edit</button><button class="rm" title="Remove">✕</button>`;
    const box = row.querySelector('input');
    box.checked = !versionOff.has(v.name);
    box.disabled = !!bouncing;
    box.onchange = () => {
      if (box.checked) versionOff.delete(v.name);
      else versionOff.add(v.name);
      saveVersions();
      renderSummary();
    };
    row.querySelector('.vname').textContent = v.name;
    const mutes = row.querySelector('.vmutes');
    const missing = session ? S.resolveChannels(session, v.muted).missing : [];
    mutes.textContent = v.muted.length ? `mutes ${v.muted.join(', ')}` : 'nothing muted';
    if (missing.length) {
      const w = document.createElement('span');
      w.className = 'warn';
      w.textContent = `  · not in this session: ${missing.join(', ')}`;
      mutes.appendChild(w);
    }
    mutes.title = mutes.textContent;
    row.querySelector('.edit').disabled = !!bouncing;
    row.querySelector('.edit').onclick = () => openEditor(i);
    row.querySelector('.rm').disabled = !!bouncing || versions.length === 1;
    row.querySelector('.rm').onclick = () => {
      versionOff.delete(v.name);
      versions.splice(i, 1);
      saveVersions();
      renderAll();
    };
    root.appendChild(row);
  });
}

function openEditor(index) {
  editing = index;
  const v = index >= 0 ? versions[index] : { name: '', muted: [] };
  $('vname').value = v.name;
  const list = $('chlist');
  list.innerHTML = '';
  const muted = new Set(v.muted);
  const channels = session ? S.mutableChannels(session) : [];
  const names = [];
  for (const ch of channels) {
    const n = (ch.name.value ?? '').trim();
    if (n && !names.includes(n)) names.push(n);
  }
  const kindOf = (n) => {
    const ch = channels.find((c) => (c.name.value ?? '').trim() === n);
    return ch?.busType ? (ch.folderMode?.value && ch.folderMode.value !== 'none' ? 'folder' : 'bus') : '';
  };
  const add = (n, gone) => {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox"> <span></span> <span class="kind"></span>`;
    label.querySelector('input').checked = muted.has(n);
    label.querySelector('input').value = n;
    label.querySelector('span').textContent = n;
    label.querySelector('.kind').textContent = gone ? 'not in this session' : kindOf(n);
    if (gone) label.classList.add('gone');
    list.appendChild(label);
  };
  // Buses and folders first: they are what versions usually mute.
  for (const n of names.filter((x) => kindOf(x))) add(n, false);
  for (const n of names.filter((x) => !kindOf(x))) add(n, false);
  for (const n of v.muted.filter((x) => !names.includes(x))) add(n, true);
  if (!list.childElementCount) list.textContent = 'This session has no tracks or buses yet.';
  $('editor').hidden = false;
  $('vname').focus();
}

function saveEditor() {
  const name = $('vname').value.trim();
  if (!name) {
    $('vname').focus();
    return;
  }
  const clash = versions.findIndex((v, i) => i !== editing && v.name.toLowerCase() === name.toLowerCase());
  if (clash >= 0) {
    log(`There is already a version called ${versions[clash].name}.`, true);
    return;
  }
  const muted = [...$('chlist').querySelectorAll('input:checked')].map((b) => b.value);
  const v = { name, muted };
  if (editing >= 0) {
    const old = versions[editing].name;
    if (versionOff.has(old)) {
      versionOff.delete(old);
      versionOff.add(name);
    }
    versions[editing] = v;
  } else versions.push(v);
  saveVersions();
  closeEditor();
  renderAll();
}

function closeEditor() {
  editing = null;
  $('editor').hidden = true;
}

// ---- minus-one packages ----

function channelNames() {
  const names = [];
  for (const ch of session ? S.mutableChannels(session) : []) {
    const n = (ch.name.value ?? '').trim();
    if (n && !names.includes(n)) names.push(n);
  }
  return names;
}

function renderPackages() {
  // The part picker: every track and bus not already packaged.
  const pick = $('pkgPart');
  const had = pick.value;
  pick.innerHTML = '';
  const free = channelNames().filter((n) => !packages.some((p) => p.part === n));
  const first = document.createElement('option');
  first.value = '';
  first.textContent = free.length ? 'Part to leave out…' : 'No tracks or buses';
  pick.appendChild(first);
  for (const n of free) {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n;
    pick.appendChild(o);
  }
  if (free.includes(had)) pick.value = had;

  const root = $('packages');
  root.innerHTML = '';
  if (!packages.length) {
    root.innerHTML = '<div class="empty">For a session player: the song without their part, plus their part alone, lined up from the song’s start. Pick a part and click Add.</div>';
    return;
  }
  const names = channelNames();
  packages.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'pkg';
    row.innerHTML = `
      <input type="checkbox" class="on"><span class="pname"></span><button class="choose">Folder…</button><button class="rm" title="Remove">✕</button>
      <div class="opts">
        <label>Part file <select class="from"><option value="raw">raw, from its own channel</option><option value="main">through the main (soloed)</option></select></label>
        <label><input type="checkbox" class="bpm"> BPM in names</label>
        <span class="pfolder"></span>
      </div>
      <div class="files"></div>`;
    const busy = !!bouncing;
    const on = row.querySelector('.on');
    on.checked = !packageOff.has(p.part);
    on.disabled = busy;
    on.onchange = () => {
      if (on.checked) packageOff.delete(p.part);
      else packageOff.add(p.part);
      savePackages();
      renderAll();
    };
    const name = row.querySelector('.pname');
    name.textContent = names.includes(p.part) ? `For ${p.part}` : `For ${p.part} (not in this session)`;
    if (!names.includes(p.part)) name.classList.add('status', 'err');
    const from = row.querySelector('.from');
    from.value = p.partFrom;
    from.disabled = busy;
    from.onchange = () => {
      p.partFrom = from.value;
      savePackages();
      renderAll();
    };
    const bpm = row.querySelector('.bpm');
    bpm.checked = p.bpm;
    bpm.disabled = busy;
    bpm.onchange = () => {
      p.bpm = bpm.checked;
      savePackages();
      renderAll();
    };
    const f = row.querySelector('.pfolder');
    f.textContent = p.folder ? `Saved to ${p.folder}` : 'Saved with the songs';
    f.title = p.folder;
    row.querySelector('.choose').disabled = busy;
    row.querySelector('.choose').onclick = () => choosePackageFolder(p);
    row.querySelector('.rm').disabled = busy;
    row.querySelector('.rm').onclick = () => {
      packages.splice(i, 1);
      packageOff.delete(p.part);
      savePackages();
      renderAll();
    };
    const example = songs.find((s) => s.reason !== 'empty');
    if (example && session) {
      const [minus, alone] = S.packagePasses(session, p);
      row.querySelector('.files').textContent = `${minus.fileName(example)}  +  ${alone.fileName(example)}`;
    }
    root.appendChild(row);
  });
}

function addPackage() {
  const part = $('pkgPart').value;
  if (!part) {
    $('pkgPart').focus();
    return;
  }
  packages.push({ part, partFrom: 'raw', bpm: true, folder: '' });
  savePackages();
  renderAll();
}

async function choosePackageFolder(p) {
  try {
    if (!(await luna.gui.available())) {
      log('Choosing a folder needs LUNA’s window. Open Song Bounce from LUNA’s Add Ons menu.', true);
      return;
    }
    const [picked] = await luna.gui.chooseFolders({
      title: `Folder for ${p.part} (use New Folder to make one)`,
      defaultPath: p.folder || folder || undefined,
    });
    if (!picked) return;
    p.folder = picked === folder ? '' : picked;
    savePackages();
    renderAll();
  } catch (e) {
    log(`Could not choose a folder: ${e.message}`, true);
  }
}

// ---- songs ----

function renderSongs() {
  const tl = session?.musical.timeline;
  const body = $('songs');
  body.innerHTML = '';
  const shown = currentPasses();
  for (const song of songs) {
    const tr = document.createElement('tr');
    const empty = song.reason === 'empty';
    if (empty) tr.className = 'empty';
    tr.innerHTML = `<td><input type="checkbox"></td><td><div class="name"></div><div class="how"></div></td><td class="num start"></td><td class="num len"></td><td class="status"></td>`;
    const box = tr.querySelector('input');
    box.checked = !empty && !unticked.has(song.name);
    box.disabled = empty || !!bouncing;
    box.onchange = () => {
      if (box.checked) unticked.delete(song.name);
      else unticked.add(song.name);
      renderSummary();
    };
    tr.querySelector('.name').textContent = song.name;
    tr.querySelector('.how').textContent =
      trimming() && S.canTrim(song) ? `ends where the sound fades below ${trimDb()} dB (measured when bouncing)` : HOW[song.reason];
    try {
      tr.querySelector('.start').textContent = tl.formatBarBeat(song.start);
      const len = fmtLength(tl.seconds(song.end) - tl.seconds(song.start));
      tr.querySelector('.len').textContent = empty ? '' : trimming() && S.canTrim(song) ? `≤ ${len}` : len;
    } catch {
      /* tempo map still loading */
    }
    const cell = tr.querySelector('.status');
    for (const v of shown) {
      const st = status.get(key(song, v));
      if (!st) continue;
      const span = document.createElement('span');
      span.className = 'vs';
      const label = shown.length > 1 ? `${v.label} ` : '';
      if (st.kind === 'progress') {
        span.textContent = label;
        const p = document.createElement('progress');
        p.max = 1;
        p.value = st.progress ?? 0;
        p.dataset.key = key(song, v);
        span.appendChild(p);
      } else {
        span.textContent = label + { ok: '✓', err: '✕', wait: '·' }[st.kind];
        span.classList.add('status', st.kind === 'wait' ? 'how' : st.kind);
      }
      cell.appendChild(span);
    }
    body.appendChild(tr);
  }
  $('table').hidden = songs.length === 0;
  $('none').hidden = songs.length > 0 || !session;
  $('none').textContent =
    mode() === 'whole'
      ? 'Nothing to bounce yet: no clips play in this session.'
      : 'No songs yet. Add a marker at the start of each song and name it after the song. ' +
        'Each song ends after its last clip plus the tail, or at a marker named “End”.';
}

function renderSummary() {
  const n = bounceableSongs().length;
  const vs = tickedVersions().length;
  const ps = tickedPackages().length;
  const what = [vs ? plural(vs, 'version') : '', ps ? plural(ps, 'package') : ''].filter(Boolean).join(' + ');
  $('summary').textContent = songs.length ? `${n} of ${plural(songs.length, 'song')}${what ? ` × ${what}` : ''}` : '';
  const busy = !!bouncing;
  const files = n * currentPasses().length;
  $('bounce').disabled = busy || !session || !folder || files === 0;
  $('bounce').textContent = files ? `Bounce ${plural(files, 'file')}` : 'Bounce';
  $('stop').disabled = !busy;
  for (const id of ['mode', 'all', 'noneBtn', 'refresh', 'choose', 'tail', 'trimDb', 'endMode', 'addVersion', 'addPkg', 'pkgPart']) $(id).disabled = busy || !session;
  $('reveal').disabled = !folder;
}

function renderFolder() {
  $('folder').textContent = folder || 'choose a folder';
  $('folder').title = folder;
  renderSummary();
}

function renderAll() {
  renderVersions();
  renderPackages();
  renderSongs();
  renderSummary();
}

let refreshTimer;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 250);
}

async function refresh() {
  if (!session || bouncing) return;
  const s = session;
  try {
    const found = await S.songs(s, trimming() ? S.TRIM_MAX_SECONDS : tailSeconds(), mode());
    if (s !== session) return;
    songs = found;
    renderAll();
  } catch (e) {
    log(`Could not read the songs: ${e.message}`, true);
  }
}

// ---- interrupted bounces ----

function pendingKey() {
  return session ? `pending.${session.uid}` : null;
}
function showBanner() {
  $('banner').hidden = !(session && read(pendingKey(), null) && !bouncing);
}
async function restorePending() {
  const snap = session && read(pendingKey(), null);
  if (!snap) return showBanner();
  $('restoreBtn').disabled = true;
  try {
    const stuck = await S.restoreSafely(luna, session, snap);
    if (stuck.length) log(`Could not put back: ${stuck.join(', ')}. Check their mute and automation mode.`, true);
    else {
      write(pendingKey(), null);
      log('Mutes and automation modes put back as they were.');
    }
  } catch (e) {
    log(`Restore failed: ${e.message}`, true);
  } finally {
    $('restoreBtn').disabled = false;
    showBanner();
  }
}

// ---- bouncing ----

/**
 * Make sure a folder exists before bouncing into it. LUNA does not create folders and an Add On
 * cannot, so when one is missing, LUNA's folder dialog opens at the nearest folder above it,
 * where the user can make it with New Folder. Resolves to the folder to use, or null to stop.
 */
async function ensureFolder(path, what) {
  if (!(await luna.gui.available())) return path; // cannot check outside LUNA; files are verified after
  if ((await S.folderExists(luna, path)) !== false) return path;
  const name = path.replace(/[\\/]+$/, '').split('/').pop();
  let start = S.parentFolder(path);
  while (start !== '/' && (await S.folderExists(luna, start)) === false) start = S.parentFolder(start);
  log(`${what}: “${name}” doesn’t exist. Make it with New Folder, or pick another folder.`, true);
  const [picked] = await luna.gui.chooseFolders({ title: `“${name}” doesn’t exist yet: use New Folder to make it`, defaultPath: start });
  if (!picked) return null;
  return picked;
}

async function bounce() {
  if (!session || bouncing) return;
  // Every folder this bounce writes to must exist first.
  const chosen = await ensureFolder(folder, 'Song folder');
  if (!chosen) return log('Bounce cancelled: no folder chosen.', true);
  if (chosen !== folder) {
    folder = chosen;
    write(`folder.${session.uid}`, folder);
    renderFolder();
  }
  for (const p of tickedPackages().filter((x) => x.folder)) {
    const f = await ensureFolder(p.folder, `For ${p.part}`);
    if (!f) return log('Bounce cancelled: no folder chosen.', true);
    if (f !== p.folder) {
      p.folder = f === folder ? '' : f;
      savePackages();
    }
  }
  await refresh(); // markers or clips may have moved since the list was drawn
  let list = bounceableSongs();
  const passes = currentPasses();
  if (!list.length || !passes.length) return;

  const solo = await S.soloed(session);
  $('warning').hidden = !solo.length;
  $('warning').textContent = solo.length ? `Soloed: ${solo.join(', ')}. Only soloed channels will be in the bounces.` : '';
  if (solo.length) log(`Note: ${solo.join(', ')} soloed`, true);

  const signal = {};
  bouncing = { signal };
  status.clear();
  for (const p of passes) for (const s of list) status.set(key(s, p), { kind: 'wait' });
  closeEditor();
  showBanner();
  renderAll();
  const total = list.length * passes.length;
  log(`Bouncing ${plural(total, 'file')} to ${folder}`);
  const started = Date.now();
  let ok = 0;
  const pk = pendingKey();
  try {
    if (trimming() && list.some((s) => S.canTrim(s))) {
      if (await luna.gui.available()) {
        log(`Measuring where each song fades below ${trimDb()} dB…`);
        list = await S.trimSongs(session, list, folder, {
          signal,
          thresholdDb: trimDb(),
          readWav: (path) => S.readWav(luna, path),
          onEvent: (e) => {
            if (e.type === 'trimmed') log(`${e.song.name}: ends ${e.song.tailSeconds.toFixed(1)} s after its last clip`);
            if (e.type === 'trim-failed') log(`${e.song.name}: could not measure (${e.error?.message ?? e.error}); keeping the full ${S.TRIM_MAX_SECONDS} s`, true);
          },
        });
        // Show the measured lengths while the real bounces run.
        songs = songs.map((s) => list.find((t) => t.name === s.name) ?? s);
        renderSongs();
      } else {
        log(`Trimming needs LUNA’s window: open Song Bounce from LUNA’s Add Ons menu. Using a ${tailSeconds()} s tail instead.`, true);
        const fixed = await S.songs(session, tailSeconds(), mode());
        list = list.map((s) => fixed.find((t) => t.name === s.name) ?? s);
      }
    }
    const gui = await luna.gui.available();
    const { notRestored } = await S.runPasses(luna, session, list, passes, folder, {
      signal,
      // Check each file is really on disk: LUNA says "done" even when it could not write it.
      verify: gui ? (path) => luna.gui.serveMediaFile(S.ADD_ON_ID, path).then(() => true, () => false) : undefined,
      onSnapshot: (snap) => write(pk, snap && Object.keys(snap).length ? snap : null),
      onEvent: (e) => {
        if (e.type === 'pass') {
          if (passes.length > 1) log(`— ${e.pass.label}`);
          return;
        }
        const k = key(e.song, e.pass);
        if (e.type === 'start') status.set(k, { kind: 'progress', progress: 0 });
        else if (e.type === 'progress') {
          const bar = document.querySelector(`#songs progress[data-key="${CSS.escape(k)}"]`);
          if (bar) bar.value = e.progress;
          return;
        } else if (e.type === 'done') {
          ok++;
          status.set(k, { kind: 'ok' });
          log(`${e.song.fileName}`);
        } else if (e.type === 'failed') {
          status.set(k, { kind: 'err' });
          log(`${e.song.name} (${e.pass.label}): ${e.error?.message ?? e.error}`, true);
        }
        renderSongs();
      },
    });
    if (notRestored.length) log(`Could not put back: ${notRestored.join(', ')}. Use Restore mutes.`, true);
  } catch (e) {
    log(`Bounce stopped: ${e.message}`, true);
  } finally {
    bouncing = null;
    const secs = Math.round((Date.now() - started) / 1000);
    log(`${ok} of ${plural(total, 'file')} bounced in ${fmtLength(secs)}`, ok < total);
    showBanner();
    renderAll();
  }
}

function stop() {
  if (!bouncing) return;
  bouncing.signal.stop = true;
  bouncing.signal.render?.abort().catch(() => {});
  log('Stopping…');
}

// ---- session ----

let bindQueue = Promise.resolve();
function bindSession() {
  bindQueue = bindQueue.then(bindSessionNow, bindSessionNow);
  return bindQueue;
}

async function bindSessionNow() {
  const next = luna.sessions.current();
  if (next && next === session) return;
  for (const off of releases) off();
  releases = [];
  session = next;
  songs = [];
  status.clear();
  unticked.clear();
  closeEditor();
  if (!session) {
    $('session').textContent = 'no session open';
    folder = '';
    renderFolder();
    renderAll();
    showBanner();
    return;
  }
  const s = session;
  await s.ready();
  if (s !== session) return;
  $('session').textContent = s.name.value ?? '';
  $('mode').value = read(`mode.${s.uid}`, 'whole');
  $('modeHow').textContent = MODE_HOW[mode()];
  folder = read(`folder.${s.uid}`, '') || (await S.exportFolder(luna, s)) || '';
  renderFolder();
  showBanner();
  await s.markers.load();
  releases.push(s.markers.onChange(refreshSoon));
  releases.push(s.tracks.onChange(refreshSoon));
  releases.push(s.buses.onChange(refreshSoon));
  releases.push(s.musical.timeline.onChange(refreshSoon));
  await refresh();
}

async function chooseFolder() {
  try {
    if (!(await luna.gui.available())) {
      log('Choosing a folder needs LUNA’s window. Open Song Bounce from LUNA’s Add Ons menu.', true);
      return;
    }
    const [picked] = await luna.gui.chooseFolders({ title: 'Bounce songs to…', defaultPath: folder || undefined });
    if (!picked || !session) return;
    folder = picked;
    write(`folder.${session.uid}`, folder);
    renderFolder();
  } catch (e) {
    log(`Could not choose a folder: ${e.message}`, true);
  }
}

async function connect() {
  $('ver').textContent = `v${S.VERSION}`;
  versions = S.parseVersions(read('versions', null));
  versionOff = new Set(read('versionsOff', []));
  packages = S.parsePackages(read('packages', []));
  packageOff = new Set(read('packagesOff', []));
  $('addPkg').onclick = addPackage;
  $('modeHow').textContent = MODE_HOW[mode()];
  $('mode').onchange = () => {
    if (session) write(`mode.${session.uid}`, mode());
    $('modeHow').textContent = MODE_HOW[mode()];
    unticked.clear();
    status.clear();
    refresh();
  };
  $('endMode').value = read('endMode', 'trim');
  $('trimDb').value = read('trimDb', S.DEFAULT_TRIM_DB);
  const showEnd = () => {
    $('trimBox').hidden = !trimming();
    $('tailBox').hidden = trimming();
  };
  showEnd();
  $('endMode').onchange = () => {
    write('endMode', $('endMode').value);
    showEnd();
    refresh();
  };
  $('trimDb').onchange = () => {
    $('trimDb').value = trimDb();
    write('trimDb', trimDb());
    renderSongs();
  };
  $('tail').value = read('tail', S.DEFAULT_TAIL_SECONDS);
  $('tail').onchange = () => {
    $('tail').value = tailSeconds();
    write('tail', tailSeconds());
    refresh();
  };
  $('bounce').onclick = bounce;
  $('stop').onclick = stop;
  $('refresh').onclick = refresh;
  $('choose').onclick = chooseFolder;
  $('reveal').onclick = async () => {
    if (folder && (await luna.gui.available())) luna.gui.revealPath(folder).catch(() => {});
  };
  $('all').onclick = () => {
    unticked.clear();
    renderAll();
  };
  $('noneBtn').onclick = () => {
    for (const s of songs) unticked.add(s.name);
    renderAll();
  };
  $('addVersion').onclick = () => openEditor(-1);
  $('vsave').onclick = saveEditor;
  $('vcancel').onclick = closeEditor;
  $('vname').onkeydown = (e) => {
    if (e.key === 'Enter') saveEditor();
    if (e.key === 'Escape') closeEditor();
  };
  $('restoreBtn').onclick = restorePending;
  $('forgetBtn').onclick = () => {
    write(pendingKey(), null);
    showBanner();
  };
  renderAll();

  for (;;) {
    try {
      luna = await Luna.connect();
      break;
    } catch (e) {
      $('session').textContent = e instanceof Luna.NotRunning ? 'waiting for LUNA…' : e.message;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  Luna.bindShortcuts(luna);
  luna.status.onChange(() => {
    if (luna.status.value === 'disconnected') $('session').textContent = 'reconnecting…';
    if (luna.status.value === 'connected') {
      session = null;
      bindSession();
    }
  });
  await luna.sessions.ready();
  luna.sessions.focused.onChange(bindSession);
  luna.sessions.items.onChange(bindSession);
  await bindSession();
}

connect();
