# SAR Command & Track — Account Setup Handoff

You are helping set up third-party accounts and API tokens for a new web app called **SAR Command & Track** — a search and rescue coordination tool. 

Your job is to walk through the steps below, collect the values, and return a completed `.env` block at the end that the developer can paste directly into their project.

---

## What you need to set up

1. **Firebase project** (free) — real-time database + authentication
2. **Mapbox account** (free tier) — interactive maps

---

## Step 1: Firebase

### 1a. Create the project

1. Go to https://console.firebase.google.com
2. Click **Add project**
3. Project name: `sar-command`
4. Disable Google Analytics (not needed)
5. Click **Create project**

### 1b. Enable Firestore

1. In the left sidebar → **Build → Firestore Database**
2. Click **Create database**
3. Select **Start in production mode**
4. Choose a region close to you (e.g. `us-central1`)
5. Click **Done**

### 1c. Enable Authentication

1. In the left sidebar → **Build → Authentication**
2. Click **Get started**
3. Under **Sign-in method** tab → click **Email/Password**
4. Toggle **Enable** → Save

### 1d. Create the first command center user

1. Still in Authentication → click the **Users** tab
2. Click **Add user**
3. Email: (Jack's email — ask him)
4. Password: (strong password — ask Jack or generate one)
5. Click **Add user**

### 1e. Get the Firebase config

1. In the left sidebar → click the ⚙️ gear icon → **Project settings**
2. Scroll down to **Your apps**
3. Click the **</>** (web) icon to add a web app
4. App nickname: `command-center`
5. Do NOT check "Also set up Firebase Hosting" 
6. Click **Register app**
7. You'll see a `firebaseConfig` object like this:

```javascript
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "sar-command-xxxxx.firebaseapp.com",
  projectId: "sar-command-xxxxx",
  storageBucket: "sar-command-xxxxx.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef123456"
};
```

Copy all six values — you'll need them for the `.env` file.

---

## Step 2: Mapbox

### 2a. Create account

1. Go to https://account.mapbox.com/auth/signup/
2. Sign up with an email + password
3. Confirm your email

### 2b. Get your default public token

1. After signup, you land on your account dashboard
2. You'll see a **Default public token** already created (starts with `pk.`)
3. Copy that token

> The free tier includes 50,000 map loads/month — more than enough for a SAR team.

---

## Step 3: Return this completed block

Once you have everything, return the following filled in — the developer will paste it directly into their `.env` file:

```
VITE_FIREBASE_API_KEY=<apiKey from Step 1e>
VITE_FIREBASE_AUTH_DOMAIN=<authDomain from Step 1e>
VITE_FIREBASE_PROJECT_ID=<projectId from Step 1e>
VITE_FIREBASE_STORAGE_BUCKET=<storageBucket from Step 1e>
VITE_FIREBASE_MESSAGING_SENDER_ID=<messagingSenderId from Step 1e>
VITE_FIREBASE_APP_ID=<appId from Step 1e>
VITE_MAPBOX_TOKEN=<pk.xxx token from Step 2b>
```

Also confirm:
- [ ] Firebase project created: `sar-command`
- [ ] Firestore database enabled (production mode)
- [ ] Email/Password auth enabled
- [ ] Command center user created (email + password)
- [ ] Mapbox account created
- [ ] All 7 env values collected

---

## What happens next

Once you return the completed `.env` block, the developer will:
1. Paste it into `C:\Users\Jack\Desktop\SAR Command\command-center\.env`
2. Resume building the app (Phase 1 command center is already planned and ready to implement)
