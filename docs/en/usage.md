# Usage

[中文](../zh/usage.md) | **English**

**GGPoker Record Download Helper** is a Chrome extension that downloads your game summaries and hand histories from PokerCraft in bulk. The extension picks the dates, batches them, and tracks each batch; you click the download button once per batch.

## 1. Installation

Pick one of the three ways below.

### Option 1: Chrome Web Store (easiest)

1. Search the Chrome Web Store for "GGPoker记录下载助手"
2. Open the listing and click "Add to Chrome"
3. Confirm with "Add extension"

### Option 2: Install from the RealtimeGTO client

1. Open the RealtimeGTO client and go to "GG Data Import"
2. Click "Install GG download extension" — the client unpacks the package and shows you where it is
3. Continue from step 2 of Option 3 below

### Option 3: Manual install (developer mode)

1. Download the latest zip from this repository's Releases page and unpack it somewhere you won't delete by accident
2. Type `chrome://extensions/` in the address bar and press Enter
3. Turn on "Developer mode" in the top right
4. Click "Load unpacked" and select **the folder that directly contains `manifest.json`**

**This is the step people get wrong**: select the folder that holds `manifest.json` itself. If you pick its parent (your unzip tool added an extra level) or a child (the subfolder holding the interface files), Chrome will refuse to load it.

## 2. Signing in and licensing

The extension requires a licensed account.

1. Click the extension icon to open the side panel — first run shows the sign-in form
2. Enter your username and password and click "Login"
3. Tick "Remember password" and you will be signed in automatically next time
4. To switch accounts, click "Logout" in the top right of the side panel

No account yet? Click "Create account" on the sign-in form, or register on the RtGTO website.

## 3. Reading the main panel

Once signed in, the side panel shows, from top to bottom:

| Area | What it shows |
| --- | --- |
| Top bar | A link to the RtGTO website, the Chinese/English switch, and Logout |
| Sync card | The card title is the game page you are on, with a badge next to it: "summaries + hands", "hands only (no summary)" or "page not recognised" |
| └ Synced up to | The date this category has been synced through; the next run continues after it |
| └ Last data sync | When a sync actually ran last |
| └ This run | The date range and day count about to be downloaded (worked out for you) |
| └ Date interval | How many days each batch covers. It reads "Auto" — the extension decides; there is nothing to set |
| Buttons | "Sync Now" (becomes "Stop" while running) and "Pause" (becomes "Resume" when paused) |
| Clear sync record | Wipes this category's progress so the next sync starts over |
| Download check | Connection status with the local RealtimeGTO client and verification results — see sections 6 and 7 |
| Run log | What the extension did, step by step — see section 8 |
| Notes | Five usage notes, collapsed |

## 4. Starting a sync

1. **Open a game page first.** On PokerCraft, open one of Tournaments (MTT), Rush & Cash, Hold'em Cash or Omaha (PLO). The extension has to see the page to know which category to sync; if it cannot tell, the card shows "page not recognised" and starting a sync reports "no category recognised"
2. Click "Sync Now"

From there the extension arranges everything:

- **The sync range and batch size are chosen automatically; no manual setup needed** — the range runs from the day after "Synced up to" through today, and how many days each batch covers depends on how the page list loads
- At the start of each batch the extension selects the dates and **highlights the download button and waits until you click it; it will not continue otherwise**
- Once you click, that batch finishes and the next one begins automatically until the sync is done

While it runs:

- "Pause" stops it; click again to resume
- "Stop" ends the current sync
- The progress indicator shows which day it is on

**Interruptions are safe**: already-synced dates are not downloaded again, and the next run continues from where it stopped.

To start over, click "Clear sync record" for that category and run it again.

## 5. GGPoker's own download limits

Two things are not up to this tool — they are GGPoker's own rules:

- **Game summaries**: at most **500** within the last **12 months**.
- **Hand histories**: at most **20,000** hands within the last **3 months**.

One more thing to know: **only Tournaments (MTT) have summaries.** Rush & Cash, Hold'em Cash and Omaha (PLO) carry hands only — the panel marks them "hands only (no summary)" and notes that this type has hand details for the last 3 months at most.

Putting the two together:

- **Tournaments (MTT)**: the last 3 months give summaries and hands; from 3 to 12 months back you get summaries only; older than that, nothing
- **The other three**: hands for the last 3 months only; older dates give nothing at all

This is not a malfunction — it is a limit of the data source itself. When a range exceeds the per-download limit, the extension splits it into several passes automatically; you do not need to break it up yourself.

## 6. Download records and repair

The extension can only confirm that you **clicked** the download button — it cannot confirm the file actually arrived (an interrupted connection fails silently). So the outcome of every date range is recorded in the "Download check" card.

**Export and import live behind "More actions"**, collapsed inside that card:

- "Export JSON" / "Export CSV": save the download records as a file
- "Import check results": bring in results if you verified completeness with another tool
- "Clear records": wipes the download records (sync progress is untouched)

**Repair is automatic — there is nothing to click.** At the end of a sync the results are checked, and the missing date ranges are **downloaded automatically the next time you click "Sync Now"**, without disturbing existing progress. The card tells you how many ranges and days are waiting:

> The next time you click "Sync Now", these N ranges (M days) will be downloaded automatically afterwards.

Dates that have fallen outside GGPoker's retention window cannot be recovered, and the card says which ones those are.

## 7. Optional: verification with a local RealtimeGTO client

If the RealtimeGTO client is installed on this machine, it can verify your downloads.

1. Open the RealtimeGTO client and go to "GG Data Import"
2. The "Download check" card in the side panel connects automatically; if it shows as not connected, the client is not running
3. After each sync round the client opens the files, checks whether they arrived, whether they can be read, and whether the content type matches, then reports back to the side panel

What the results mean:

| Result | Meaning |
| --- | --- |
| Imported | Everything is fine |
| Count mismatch | The number of sessions or hands in the file differs from what the download button showed |
| Still downloading | The file has not finished downloading |
| Interrupted | The download was interrupted |
| No download detected | You clicked, but no matching download happened |
| File missing | It is in the records but the file cannot be found |
| File unreadable | The file is corrupt or in the wrong format |
| Wrong content type | The file is not the kind of record you asked for |

Dates that did not arrive go on the repair list and are fetched automatically as described in section 6.

## 8. Run log and reporting problems

"Run log" at the bottom of the side panel records what the extension did at each step. If something goes wrong:

1. Click "Copy log"
2. Send it to support together with a description of the problem

The log carries dates, actions and error reasons — far more useful than a description of the symptoms alone.

## 9. FAQ

**I installed it but clicking the icon does nothing.**
First check that the current page is on `my.pokercraft.com` — the extension only runs there, and other sites (ggpoker.com included) will not respond. Then check that your Chrome is version 114 or newer.

**The card says "page not recognised" and syncing reports "no category recognised".**
The extension needs to see which game page you are on. Open one of Tournaments (MTT), Rush & Cash, Hold'em Cash or Omaha (PLO) on PokerCraft, then open the side panel.

**Why do only the most recent 3 months have hand details?**
That is GGPoker's own limit — see section 5. Older dates either give summaries only (Tournaments (MTT)) or nothing at all (the other three).

**The sync stopped part-way.**
The extension is waiting for a click — every batch needs you to press the download button on the page, and it will not continue without one. Once you click, the next batch starts automatically; to interrupt instead, press "Stop".

**A download was interrupted. What now?**
Click "Sync Now" again. Already-synced dates are not downloaded twice; it continues from where it stopped.

**How do I get a licensed account?**
Register on the RtGTO website.

**Does it upload my data?**
Your account details and download records stay in your local browser. Apart from the login check, the extension does not send your data to any server.

**Do I need to reinstall on a new computer?**
Yes, reinstall the extension. The account works anywhere, but the local download records and sync progress do not travel with it.

**Where do the downloaded files go?**
Into your browser's default download folder.

## 10. Notes

The five notes at the bottom of the panel, repeated here:

1. Do not move the mouse around the page too much while a download is running
2. If anything hangs, stutters or stops responding, refresh the page and start again
3. Every batch highlights the download button and waits for your click; it will not continue until you click. To interrupt, press "Stop"
4. The extension supports four game types: Tournaments, Rush & Cash, Hold'em Cash and Omaha (PLO)
5. The sync range and batch size are chosen automatically; no manual setup needed
