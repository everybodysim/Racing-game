# Firebase Spark multiplayer setup

This project uses Firebase Realtime Database on the Spark plan for lightweight multiplayer sessions and editor collaboration rooms.

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
    },
    "editor-rooms": {
      "$roomCode": {
        ".read": true,
        ".write": true,
        ".validate": "newData.hasChildren(['mode','code','trackRevision','updatedAt','hostClientId','track']) && newData.child('mode').val() === 'editor'",
        "participants": {
          "$clientId": {
            ".validate": "!newData.exists() || newData.hasChildren(['clientId','role','updatedAt'])"
          }
        }
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

## 5) Editor collaboration usage

- The track editor hosts collaborative editing sessions under `/editor-rooms/{roomCode}`.
- Editor rooms store `mode: "editor"`, `code`, `trackRevision`, `updatedAt`, `hostClientId`, `track: { map, mods }`, and `participants/{clientId}` metadata.
- Race rooms and editor rooms intentionally do **not** share database paths: gameplay multiplayer uses `/racing-rooms/{roomCode}`, while editor collaboration uses `/editor-rooms/{roomCode}`.
- Joiners load the host snapshot into the editor grid, then compact editor snapshots are debounced before publishing back to Firebase.
