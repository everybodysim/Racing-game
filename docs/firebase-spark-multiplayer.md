# Firebase Spark multiplayer setup (implemented in this repo)

This repo now includes a built-in browser multiplayer client:

- `js/FirebaseMultiplayer.js` (Firebase Realtime Database sync client)
- Multiplayer HUD in `index.html` (`Host`, `Join`, `Leave`, room code/status)
- Remote players rendered as **ghost cars** (visual only, no physics collisions)

## 1) Do this once in Firebase

1. Create a Firebase project.
2. Add a **Web app**.
3. Enable **Realtime Database**.
4. Copy your web config object (`apiKey`, `authDomain`, `databaseURL`, etc).

## 2) Add config from iPhone (no devtools requirement)

Because this is a static GitHub Pages game, the easiest setup is storing config in local storage once.

Open this URL once on each device (replace placeholders):

```text
javascript:localStorage.setItem('racing-firebase-config-v1', JSON.stringify({"apiKey":"...","authDomain":"...","databaseURL":"https://YOUR_PROJECT-default-rtdb.firebaseio.com","projectId":"...","storageBucket":"...","messagingSenderId":"...","appId":"..."}));location.reload();
```

Alternative for developers: set `window.__RACING_FIREBASE_CONFIG` before `js/main.js` loads.

## 3) Realtime Database rules (minimal)

Use this first for easy bring-up:

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

## 4) How gameplay join works (current implementation)

- Host taps **Host** → creates 6-char room code.
- Joiner enters that code and taps **Join**.
- Join is only allowed if both players are on the same map (`map + mods` hash must match).
- Max room size is 2 players.
- Host disconnect removes room automatically.
- Remote cars are scene meshes only (never added to crashcat world), so they do not collide.

## 5) Spark-plan safety defaults

- 10 Hz presence updates
- Tiny payload (`x,y,z,yaw,v,t`)
- 2 players per room
- Automatic cleanup via `onDisconnect`

## 6) iPhone test checklist

1. Open game on iPhone A and B.
2. Load same map on both devices.
3. A: press **Host** and note room code.
4. B: enter code and press **Join**.
5. Verify both players can see each other.
6. Verify cars do **not** collide.
7. Leave/disconnect and confirm ghost disappears.
