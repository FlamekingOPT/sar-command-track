### Task 1: Project Scaffold + Dependencies

**Files:**
- Create: `command-center/package.json`
- Create: `command-center/vite.config.js`
- Create: `command-center/index.html`
- Create: `command-center/.env.example`
- Create: `command-center/.gitignore`
- Create: `command-center/.env`  ← populated with real credentials (see below)

**Interfaces:**
- Produces: dev server at `http://localhost:5173`, `npm test` command

- [ ] **Step 1: Init git at monorepo root**

```bash
cd "C:\Users\Jack\Desktop\SAR Command"
git init
```

- [ ] **Step 2: Scaffold Vite + React**

```bash
npm create vite@latest command-center -- --template react
cd command-center
```

- [ ] **Step 3: Install dependencies**

```bash
npm install firebase@^10 mapbox-gl@^3 "@mapbox/mapbox-gl-draw@^1.4" "@turf/turf@^6"
npm install -D vitest@^1 jsdom
```

- [ ] **Step 4: Replace vite.config.js**

```javascript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: { environment: 'node' },
});
```

- [ ] **Step 5: Add test script to package.json**

Ensure `scripts` in `command-center/package.json` includes:
```json
"test": "vitest run"
```

- [ ] **Step 6: Create .env.example**

```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
VITE_MAPBOX_TOKEN=
```

- [ ] **Step 7: Create .env with real credentials**

```
VITE_FIREBASE_API_KEY=AIzaSyBYP0-s6qWvNaqH4uskjy1YUeP8xXVdGc8
VITE_FIREBASE_AUTH_DOMAIN=sar-trackhatzolah.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=sar-trackhatzolah
VITE_FIREBASE_STORAGE_BUCKET=sar-trackhatzolah.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=1012419291732
VITE_FIREBASE_APP_ID=1:1012419291732:web:bb28fa1d91560edcc75bc1
VITE_MAPBOX_TOKEN=pk.eyJ1IjoiaGF0em9sYWhsYSIsImEiOiJjbXF5M2cxcm0xeWI0MnRxMnRyN2t0emozIn0.q2VcBeQqk2ZpZvOplzklPw
```

- [ ] **Step 8: Create .gitignore**

```
node_modules/
dist/
.env
.env.local
```

- [ ] **Step 9: Verify dev server starts**

```bash
cd "C:\Users\Jack\Desktop\SAR Command\command-center"
npm run dev
```
Expected: Vite server running at `http://localhost:5173`. You cannot open a browser — just confirm the process starts without error and outputs the localhost URL, then stop it (Ctrl+C).

- [ ] **Step 10: Commit**

```bash
cd "C:\Users\Jack\Desktop\SAR Command"
git add --all -- ':!command-center/.env'
git commit -m "feat: scaffold command-center Vite + React project"
```

Note: `.env` is gitignored — do NOT commit it. Use `git add --all -- ':!command-center/.env'` to stage everything except the .env file.
