# Firebase Spark multiplayer setup

This project uses Firebase Realtime Database on the Spark plan for lightweight multiplayer sessions.

## 1) Firebase Console setup

1. Create a Firebase project.
2. Add a **Web app** in the project settings.
3. Enable **Realtime Database** (start in locked mode is fine).
4. Paste multiplayer rules into Realtime Database Rules and publish. Example starter rules for this project:

```json
{
  "rules": {
    "racing-rooms": {
      "$roomCode": {
        ".read": true,
        ".write": true,
        ".validate": "newData.hasChildren(['code','mapSignature','updatedAt']) || newData.child('status').val() === 'joined'"
      }
    }
  }
}
```

If you leave the default locked rules, host/join will fail with `Permission denied`.

## 2) Add Firebase keys in this repo

1. Open `js/firebase-config.js`.
2. Copy the Firebase Web config object values from Firebase Console.
3. Replace the placeholder values (`PASTE_..._HERE`) with your real keys.

## 3) Deploy

Deploy the site to GitHub Pages (or your normal static host flow).

## 4) In-game usage

- Host picks multiplayer host mode and receives a 6-character room code.
- Join enters that code to connect.
- Join only succeeds when both players are on the same map.
- Remote cars are ghosted (non-colliding) so network peers never physically collide.
