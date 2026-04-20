# Firebase Spark multiplayer (all-browser, GitHub Pages, iPhone-friendly)

This guide gives you a **minimum Firebase setup** and keeps multiplayer logic in your frontend repo.

## Goal

- Works from GitHub Pages (static site).
- Works on iPhone Safari (no terminal/devtools needed after deploy).
- Host creates a short room code.
- Joiner enters room code.
- Players must be on the same map to join.
- Cars do **not** collide in multiplayer mode.

---

## 1) Firebase project (one-time, minimal)

1. Open [Firebase Console](https://console.firebase.google.com/).
2. Create project (or reuse one).
3. Add a **Web app**.
4. Enable **Realtime Database** in test mode first.
5. In Project Settings → Your apps → copy `firebaseConfig`.

You do **not** need Cloud Functions for this setup.

---

## 2) Add Firebase client scripts in your game HTML

In `index.html`, add this before your game script:

```html
<script type="module" src="./js/firebase-mp.js"></script>
```

(If your boot pipeline is different, import the module from your existing entry instead.)

---

## 3) Create `js/firebase-mp.js`

Create this file and paste the full module below.

> Replace `firebaseConfig` values with yours.

```js
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getDatabase,
  ref,
  set,
  get,
  update,
  remove,
  onValue,
  onDisconnect,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  databaseURL: 'https://YOUR_PROJECT-default-rtdb.firebaseio.com',
  projectId: 'YOUR_PROJECT',
  storageBucket: 'YOUR_PROJECT.firebasestorage.app',
  messagingSenderId: '... ',
  appId: '... ',
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const ROOM_CODE_LEN = 6;
const PRESENCE_HZ = 10; // 10 updates/sec per player

const state = {
  roomCode: null,
  playerId: crypto.randomUUID().slice(0, 8),
  mapId: null,
  isHost: false,
  unsubRemote: null,
  sendTimer: null,
  remotePlayers: new Map(),
};

function randCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < ROOM_CODE_LEN; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function uniqueCode() {
  for (let i = 0; i < 20; i++) {
    const c = randCode();
    const snap = await get(ref(db, `rooms/${c}`));
    if (!snap.exists()) return c;
  }
  throw new Error('Could not allocate room code');
}

async function hostRoom(mapId) {
  const code = await uniqueCode();
  state.roomCode = code;
  state.mapId = mapId;
  state.isHost = true;

  await set(ref(db, `rooms/${code}`), {
    hostId: state.playerId,
    mapId,
    createdAt: serverTimestamp(),
    status: 'open',
  });

  await set(ref(db, `rooms/${code}/players/${state.playerId}`), {
    id: state.playerId,
    role: 'host',
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    v: 0,
    t: Date.now(),
  });

  onDisconnect(ref(db, `rooms/${code}/players/${state.playerId}`)).remove();
  onDisconnect(ref(db, `rooms/${code}`)).remove();

  listenRemotePlayers();
  startPresenceLoop();
  return code;
}

async function joinRoom(code, mapId) {
  code = code.trim().toUpperCase();
  const roomRef = ref(db, `rooms/${code}`);
  const snap = await get(roomRef);
  if (!snap.exists()) throw new Error('Room does not exist');

  const room = snap.val();
  if (room.status !== 'open') throw new Error('Room is closed');
  if (room.mapId !== mapId) throw new Error('Map mismatch: choose the same map as host');

  state.roomCode = code;
  state.mapId = mapId;
  state.isHost = false;

  await set(ref(db, `rooms/${code}/players/${state.playerId}`), {
    id: state.playerId,
    role: 'guest',
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    v: 0,
    t: Date.now(),
  });

  onDisconnect(ref(db, `rooms/${code}/players/${state.playerId}`)).remove();

  listenRemotePlayers();
  startPresenceLoop();
}

function leaveRoom() {
  if (!state.roomCode) return;
  const code = state.roomCode;

  remove(ref(db, `rooms/${code}/players/${state.playerId}`));

  if (state.isHost) remove(ref(db, `rooms/${code}`));

  if (state.unsubRemote) state.unsubRemote();
  if (state.sendTimer) clearInterval(state.sendTimer);

  state.roomCode = null;
  state.mapId = null;
  state.isHost = false;
  state.remotePlayers.clear();
}

function listenRemotePlayers() {
  if (!state.roomCode) return;
  const playersRef = ref(db, `rooms/${state.roomCode}/players`);
  if (state.unsubRemote) state.unsubRemote();

  state.unsubRemote = onValue(playersRef, (snap) => {
    const all = snap.val() || {};
    const next = new Map();

    for (const [id, p] of Object.entries(all)) {
      if (id === state.playerId) continue;
      next.set(id, p);
    }

    state.remotePlayers = next;

    // Hook this to your renderer/game objects:
    // window.gameMultiplayer?.applyRemotePlayers(next)
  });
}

function startPresenceLoop() {
  if (state.sendTimer) clearInterval(state.sendTimer);

  state.sendTimer = setInterval(() => {
    if (!state.roomCode) return;

    // Read local player transform from your game:
    const me = window.gameMultiplayer?.getLocalSnapshot?.();
    if (!me) return;

    update(ref(db, `rooms/${state.roomCode}/players/${state.playerId}`), {
      x: me.x,
      y: me.y,
      z: me.z,
      yaw: me.yaw,
      v: me.v,
      t: Date.now(),
    });
  }, 1000 / PRESENCE_HZ);
}

// Public bridge for your UI/game code
window.firebaseMP = {
  hostRoom,
  joinRoom,
  leaveRoom,
  getState: () => ({
    roomCode: state.roomCode,
    playerId: state.playerId,
    mapId: state.mapId,
    isHost: state.isHost,
    remotePlayers: state.remotePlayers,
  }),
};
```

---

## 4) Add tiny UI hooks (host/join/leave)

Create three buttons and two inputs in your overlay menu:

- `Map` selector (already likely exists).
- `Host` button → calls `firebaseMP.hostRoom(selectedMapId)`.
- `Room code` input + `Join` button → calls `firebaseMP.joinRoom(code, selectedMapId)`.
- `Leave` button → calls `firebaseMP.leaveRoom()`.

For iPhone simplicity, keep this as normal HTML buttons in your current menu (no console/devtools needed).

---

## 5) Integrate with your existing game loop

### A. Send local state

Provide this function once in your existing code:

```js
window.gameMultiplayer = window.gameMultiplayer || {};
window.gameMultiplayer.getLocalSnapshot = () => ({
  x: player.position.x,
  y: player.position.y,
  z: player.position.z,
  yaw: player.rotation.y,
  v: player.speed,
});
```

### B. Render remote players (ghost cars)

Provide this callback:

```js
window.gameMultiplayer.applyRemotePlayers = (remoteMap) => {
  // Create/update visual-only car meshes for each remote id.
  // Interpolate for smoothness using (prev -> latest) snapshots.
};
```

### C. Disable collisions between players

Important: treat remote cars as **ghosts**.

- Do not add remote cars to your physics collision broadphase.
- Or mark remote collider layers to ignore local car layer.
- Keep local car colliding only with map/world.

This guarantees “cars do not collide with each other.”

---

## 6) Realtime Database rules (Spark-friendly)

In Firebase Realtime Database → Rules, use:

```json
{
  "rules": {
    "rooms": {
      "$code": {
        ".read": true,
        ".write": true,
        "players": {
          "$playerId": {
            ".validate": "newData.hasChildren(['id','x','y','z','yaw','v','t'])"
          }
        }
      }
    }
  }
}
```

This is intentionally minimal for easiest first launch.

After you verify gameplay works, tighten rules (auth + ownership checks).

---

## 7) Keep usage inside Spark free limits

Use these defaults to stay efficient:

- 2 players per room.
- 10 Hz position updates (not 30+).
- Small payload (just transform + velocity + timestamp).
- Remove room on host disconnect.
- TTL cleanup script (optional) for stale rooms older than 2 hours.

For a small private game, this is usually enough.

---

## 8) iPhone-only test flow (no devtools)

1. Open GitHub Pages URL on iPhone A and iPhone B.
2. Pick same map on both.
3. On iPhone A tap **Host**, note room code.
4. On iPhone B enter code and tap **Join**.
5. Drive both cars and verify:
   - both can see each other,
   - no collision/contact forces,
   - leaving removes the remote ghost within a couple seconds.

---

## 9) Optional hardening (later, still low effort)

- Add Firebase Anonymous Auth (still easy) so rules can restrict player writes to own node.
- Add `maxPlayers` check on join.
- Add host “Start race” flag under room state.
- Add simple client interpolation buffer (100–150 ms) for smoother remote motion.

---

## Quick implementation checklist

- [ ] Add `js/firebase-mp.js`.
- [ ] Add host/join/leave buttons in menu.
- [ ] Connect `getLocalSnapshot()`.
- [ ] Connect `applyRemotePlayers()`.
- [ ] Mark remote players as non-colliding ghosts.
- [ ] Paste rules and test on two iPhones.
