# Product Overview

[中文](../zh/product.md) | **English**

**GGPoker Record Download Helper** is a Chrome extension that pulls your game summaries and hand histories from PokerCraft back to your machine, in bulk — the raw material you need for review and for analysis.

It is a paid, licensed product and requires an account.

## 1. Why it exists

Downloading records from PokerCraft by hand is painful in three ways:

- **You pick dates in small pieces.** The page only lets you select a limited range at a time, so six months of records means selecting and clicking over and over.
- **You split oversized days yourself.** When a single day exceeds the per-download limit, you have to work out how to break it up.
- **A missed download looks like a success.** After you click the download button, the page never tells you whether the file actually arrived. One network hiccup and that pass was wasted — and you had no way to know.

The extension takes those three over: it works out the dates, splits whatever exceeds the limit, and records the outcome of every pass.

One thing to be clear about: **you still click the download button on the page** — that is a limit of the page itself and the extension cannot click it for you. What changes is that you no longer work out ranges, watch progress, or remember which range you already did: for every batch the extension selects the dates and highlights the button, so one click carries you to the next batch.

## 2. Who it is for

- Players who import hand histories into analysis tools for review
- Players who track their own results by period
- Anyone who wants to keep their own game records long-term instead of relying on page history

## 3. Typical uses

- **Review**: export a period's hands and walk through them one by one in an analysis tool
- **Building a database**: download in batches on a schedule and accumulate your own results
- **Reconciliation**: export the download records to see which dates you already have and which are still missing

## 4. What it does not do

Being clear about the boundaries matters more than listing features:

- **It does not click download for you.** The button on the page has to be your click; the extension's job is to have each batch ready
- It only exports **your own** records. It does not play for you, does not modify any data, and never touches your GGPoker account
- What can be retrieved depends on the data source's own limits. Summaries exist for Tournaments (MTT) only and reach back 12 months at most; hand histories reach back 3 months; the other three game types carry hands only. See section 5 of [Usage](usage.md)
- It is a data-fetching tool, not an analysis tool. Analysis is left to RealtimeGTO or to whatever tool you already use

## 5. How it works with RealtimeGTO

RealtimeGTO is our other product. When the two are used together, the split is simple:

- **The extension fetches**: it downloads records and records the outcome of every range
- **RealtimeGTO verifies and imports**: it checks whether files really arrived, whether they can be read, whether the content type matches, imports them for analysis, and reports back which dates are missing

You can use the extension without RealtimeGTO — you just export the records and check them yourself, and the extension repairs missing dates on the next sync.

## 6. How to get it

Register an account on the RtGTO website. Licensing terms, renewals and how to obtain one are all kept on the website.

## 7. Data and privacy

- Your account details and download records live only in your local browser
- Apart from the login check, the extension does not send your data to any server
- Downloaded files go straight to your browser's default download folder, with no third party involved
