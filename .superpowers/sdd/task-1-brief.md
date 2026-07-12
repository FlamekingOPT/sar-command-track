### Task 1: Firestore Rules — `zoneRequests` Collection

**Files:**
- Modify: `firestore.rules`

**Interfaces:**
- Produces: a `zoneRequests` collection where anyone can read/create, only the bot (Admin SDK, bypasses rules) can update.
- Consumed by: Task 7 (bot watcher writes), Task 13 (searcher-app reads/creates).

- [ ] **Step 1: Add the rule block**

Open `firestore.rules`. Add this block as a new top-level `match`, alongside the existing `volunteers` and `searcherLinks` blocks (not nested under `searches`):

```
    match /zoneRequests/{requestId} {
      allow read: if true;    // the picker page polls its own request doc
      allow create: if true;  // open trust model, same as tracks/markers today
      allow update: if false; // only the bot (Admin SDK, bypasses rules) resolves a request
    }
```

The full file should now read:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /volunteers/{id} {
      allow read, write: if true;
    }
    match /searcherLinks/{token} {
      allow read: if true;   // the app resolves tokens client-side
      allow write: if false; // written only by the bot via Admin SDK (bypasses rules)
    }
    match /zoneRequests/{requestId} {
      allow read: if true;    // the picker page polls its own request doc
      allow create: if true;  // open trust model, same as tracks/markers today
      allow update: if false; // only the bot (Admin SDK, bypasses rules) resolves a request
    }
    match /searches/{searchId} {
      allow read: if true;
      allow write: if request.auth != null;
      match /days/{dayId}/zones/{zoneId} {
        allow read: if true;
        allow update: if request.auth != null
          || request.resource.data.diff(resource.data).affectedKeys().hasOnly(['status']);
        allow create, delete: if request.auth != null;
      }
      match /days/{dayId}/tracks/{volunteerId} {
        allow read: if request.auth != null;
        allow create, update: if true;
      }
      match /days/{dayId}/markers/{markerId} {
        allow read: if true;
        allow create: if true;
        allow update: if request.auth != null;
      }
    }
  }
}
```

- [ ] **Step 2: Deploy the rule**

Run: `firebase deploy --only firestore:rules`
Expected: `✔ Deploy complete!` — if this fails with an auth error, run `firebase login` first.

- [ ] **Step 3: Commit**

```bash
git add firestore.rules
git commit -m "feat: firestore rule for zoneRequests collection"
```

---

