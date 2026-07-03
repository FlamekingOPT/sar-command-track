### Task 1: Scaffold telegram-bot Workspace

**Files:**
- Create: `telegram-bot/package.json`
- Create: `telegram-bot/.gitignore`
- Create: `telegram-bot/.env.example`
- Create: `telegram-bot/src/constants.js`
- Create: `telegram-bot/src/firebase/config.js`

**Interfaces:**
- Produces: `db` (Admin Firestore instance) exported from `firebase/config.js`; `DAY_ID` from `constants.js`; working `npm test` in `telegram-bot/`
- Consumed by: every later task

- [ ] **Step 1: Create telegram-bot/package.json**

```json
{
  "name": "telegram-bot",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --env-file=.env src/index.js",
    "test": "vitest run"
  }
}
```

- [ ] **Step 2: Install dependencies**

```bash
cd "C:\Users\Jack\dev\sar-command-track\telegram-bot"
npm install telegraf@^4.16 firebase-admin@^12
npm install -D vitest@^1.6
```

- [ ] **Step 3: Create .gitignore**

```
node_modules/
.env
*service-account*.json
```

- [ ] **Step 4: Create .env.example**

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_GROUP_CHAT_ID=
FIREBASE_SERVICE_ACCOUNT=
SEARCHER_APP_URL=http://localhost:5174
```

(`FIREBASE_SERVICE_ACCOUNT` is the entire service-account JSON on one line. `SEARCHER_APP_URL` points at the deployed Searcher PWA once Plan 3 ships; localhost placeholder until then.)

- [ ] **Step 5: Create src/constants.js**

```javascript
// Day management arrives in Plan 4; until then the whole system uses one fixed day,
// matching command-center/src/App.jsx.
export const DAY_ID = 'day-1';
```

- [ ] **Step 6: Create src/firebase/config.js**

```javascript
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT env var is required');
}

const app = initializeApp({
  credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});

export const db = getFirestore(app);
```

- [ ] **Step 7: Verify vitest runs (no tests yet)**

```bash
npm test
```
Expected: exits reporting no test files found (that's fine — confirms tooling works).

- [ ] **Step 8: Commit**

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add telegram-bot
git commit -m "feat(bot): scaffold telegram-bot workspace"
```

---

