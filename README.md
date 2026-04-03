# 🌿 Flora Journal — Local Setup

A naturalist's field journal that runs on your own computer.
Photos and entries are stored locally — nothing goes to the cloud.

---

## What you need

**Node.js 22 or newer** (you currently have v24 — you're good ✓)

If you ever need to update: https://nodejs.org — choose the "LTS" version.

---

## Setup (do this once)

**1. Unzip this folder** somewhere permanent — Desktop or Documents works well.

**2. Open Terminal**
   Mac: press ⌘ Space, type "Terminal", press Enter

**3. Navigate into the folder:**
```
cd ~/Downloads/flora-journal
```
(adjust the path to wherever you unzipped it)

**4. Install the two dependencies:**
```
npm install
```

This installs Express (the web server) and Multer (file uploads).
No compilation needed — should complete in a few seconds.

---

## Running the journal

Every time you want to use it:

```
npm start
```

Then open your browser and visit:
```
http://localhost:3000
```

Press **Ctrl + C** in the Terminal to stop the server.

---

## Where your data lives

```
flora-journal/
  db/
    journal.db      ← all entries (SQLite — a single file)
  uploads/
    *.jpg / *.png   ← your photos
```

**To back up:** copy the entire `flora-journal/` folder to an external drive or cloud storage.

**To move to another Mac:** copy the whole folder, run `npm install` once on the new machine, then `npm start`.

---

## Folder structure

```
flora-journal/
  server.js          ← local web server (Node.js)
  package.json       ← project config
  public/
    index.html       ← the journal UI
  db/
    journal.db       ← auto-created on first run
  uploads/           ← photos stored here
  node_modules/      ← libraries (created by npm install, don't touch)
```

---

## Troubleshooting

**"Port 3000 is already in use"**
Open `server.js`, change `const PORT = 3000` to `3001`, save, restart.

**"node:sqlite is not a module" or similar**
Your Node version is below 22. Run `node --version` to check.
Download the current LTS from https://nodejs.org and reinstall.

**Photos not showing after moving the folder**
Make sure you moved the `uploads/` folder together with everything else.
