# Super simple Firebase setup (Spark/free) for this game

This game already has multiplayer built in:

- Host / Join / Leave buttons are in the game UI.
- Room code is 6 letters.
- Only 2 players per room.
- Players must be on the same map.
- Other player is a **ghost car** (no collision).

---

## Tiny checklist (the shortest version)

1. Make Firebase project.
2. Turn on Realtime Database.
3. Paste rules (below).
4. Copy Firebase Web config.
5. Save config once on each iPhone with the one-line bookmark/script below.
6. Open game, tap **Host** on phone A, **Join** on phone B.

That’s it.

---

## Part A — Click these things in Firebase (one time)

1. Go to Firebase Console.
2. **Create project** (any name).
3. In project, click **Add app** → **Web** (`</>` icon).
4. Give it any app nickname.
5. Copy the config object Firebase shows (`apiKey`, `authDomain`, `databaseURL`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`).
6. Go to **Build → Realtime Database**.
7. Click **Create Database**.
8. Start in production or test mode (either is fine for now, because we’ll paste rules next).
9. Go to **Rules** tab and paste this:

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

10. Click **Publish**.

Done with Firebase forever (unless you want stricter security later).

---

## Part B — Save config on iPhone (no devtools needed)

You only do this once per phone.

### 1) Build your one-line setup string

Take this exact text and replace the `...` values with your real Firebase values:

```text
javascript:localStorage.setItem('racing-firebase-config-v1', JSON.stringify({"apiKey":"...","authDomain":"...","databaseURL":"https://YOUR_PROJECT-default-rtdb.firebaseio.com","projectId":"...","storageBucket":"...","messagingSenderId":"...","appId":"..."}));location.reload();
```

### 2) Run it on iPhone

Pick one:

- **Easy way:** make a Safari bookmark, then edit its URL to that full `javascript:...` line, then open game page and tap bookmark.
- **If you have any desktop once:** open game URL with `#setup`, paste line in URL bar once, press go, then reload. (Optional helper flow.)

After it runs, the game reloads and multiplayer can connect.

---

## Part C — Play multiplayer

1. Open the same game URL on both phones.
2. Make sure both are on the same map.
3. Phone A taps **Host**.
4. Phone A sees code (example: `KJ8P2Q`).
5. Phone B enters code and taps **Join**.
6. Drive. You should see the other player as a ghost car.
7. Cars do not collide with each other by design.

---

## If something doesn’t work (fast fixes)

- **“Offline” forever:** config was not saved correctly on that phone. Re-run the one-line setup.
- **Join fails:** room code typo or map mismatch.
- **No remote car:** host/join not both connected yet; check status text in multiplayer panel.
- **Still weird:** tap **Leave** on both phones, then Host + Join again.
