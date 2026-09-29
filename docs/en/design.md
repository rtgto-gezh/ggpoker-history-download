# Design Notes

[中文](../zh/design.md) | **English**

This explains **why the product is designed this way**, not how it is implemented. Interfaces, parameters and code-level detail are out of scope here.

## 1. The problem

The job sounds simple — download a user's PokerCraft records by date. What actually shapes the design is a set of constraints.

**Two hard limits from the data source:**

- Game summaries: at most **500** within the last **12 months**
- Hand histories: at most **20,000** hands within the last **3 months**

Note that the two **windows differ** (12 months versus 3 months) and so do the units (sessions versus hands). The consequence: even on the Tournaments (MTT) page, a sync spanning a year can only include hand detail for the most recent 3 months; older dates are fated to give summaries alone. There is no way around this — the interface has to say so plainly.

**The four game types each have their own scope**: Tournaments (MTT), Rush & Cash, Hold'em Cash and Omaha (PLO). They are four separate entry points on the page, and what they carry differs — **only Tournaments (MTT) have summaries**; the other three are hands only, and therefore reach back 3 months at most.

Together these settle one thing: **progress cannot be a single global date — it has to be stored per game type.**

One more precondition comes from the page itself: the extension must know which category the user is on. When it cannot tell, the interface asks the user to open the right page rather than guessing.

## 2. Batching strategy

### Cut by date, not by count

Cutting by count requires knowing the total first, and the total only appears once the list has finished loading. Dates are the dimension users actually care about, so batches are date ranges.

### The span has a ceiling, and shrinks on timeout

How many rows the page can load at once depends on the network and server at that moment. A fixed span fails in two ways: too wide and the list load times out; too narrow and the batch count explodes and syncing crawls.

So the first batch has a span ceiling, and **a timeout halves the span**, remembering the span that timed out so later batches stay under sixty percent of it. There is a counter-intuitive trade-off here: **the span is not adjusted by how fast loading is.** Measurements in production showed a 2-day list taking longer than a 31-day one (107 seconds versus 68). Shrinking on speed would only mean more loads and more clicks. The signal is whether it timed out, not whether it felt fast.

### On overflow, split by rows rather than shrinking dates

When a date range holds more records than one download allows, there are two options: split the dates finer and redo, or split the same range into several passes by list rows.

We chose the latter. Shrinking the range throws away work already done; splitting by rows only fetches what is left.

### Why the user clicks download

The download button on the page **has to be clicked by the user**: the extension selects the date range, highlights the button and waits; only after the click does the next batch begin.

This is not laziness — it is a limit of the page itself, since the extension cannot forge a user click. So the interface says so plainly ("it will not continue until you click") instead of letting users conclude the tool is broken.

## 3. "Clicked download" is not "downloaded"

This is the easiest thing to overlook in the whole product, and the one that costs users the most.

What the extension can observe is that the download button was clicked and that a download started. But an interrupted connection makes the download **fail silently** — the user sees a successful click, the file never arrives, and nothing says so at the time. The gap is usually discovered much later, when the data is needed — possibly after the source's retention window has closed, at which point it cannot be recovered at all.

So recording outcomes is treated as a first-class concern, in three stages:

1. **Record**: after each date range is handled, its outcome is stored — download clicked, confirmed no data, or failed
2. **Verify**: the records can be exported and handed to a program that can actually open the files
3. **Repair**: gaps found by verification are downloaded automatically on the next sync, leaving existing progress untouched

## 4. Working with a local RealtimeGTO client

Whether a file actually arrived, whether it opens, and whether its content type is right can only be judged by a program with access to the local files. That part is delegated to the RealtimeGTO client running on the same machine:

- **The extension**: fetches data, records the outcome of every range, and hands the results to the client
- **The client**: opens and verifies the files, imports them for analysis, and reports back the missing dates

The channel between them stays on the local machine and never goes through a server. The extension works without the client — verification just becomes something the user exports and checks themselves.

## 5. Decisions and lessons

A few moments where the design actually changed.

**A list load timeout used to be treated as "no data".** In early versions, a list that failed to load was read as "no data in this range", which silently dropped records. It now retries with a narrower span, and only stops after repeated timeouts.

**Empty results used to be trusted too readily.** Suspicious empties are now re-checked: still empty after a re-check, and it counts as genuinely having no data; data found on the re-check means that range had a problem.

**An oversized day must not be redone by shrinking dates.** The early approach split the dates finer and re-downloaded, wasting passes that had already succeeded. It now splits by rows within the same range.

**"Adjust the span by load speed" was the wrong direction.** Intuitively a fast load should widen the span and a slow one should narrow it, but measurement showed the two are unrelated — a 2-day list can be slower than a 31-day one. The rule is now timeout-based: shrink only when the load actually times out.

**A late-arriving file must not be credited to a newer click.** Downloads finish at unpredictable times, so a file from an earlier pass can land later. Downloads and records have to be matched by click time window, or a file gets attributed to the wrong date range.

**Version numbers are frozen during testing, so builds get their own number.** The extension needs to know whether the user's copy is old, but the version number does not change with every packaging run during the test period. Each build therefore carries an incrementing build number, which the client compares to prompt for an update.

## 6. Known boundaries and non-goals

- It exports the user's own records only; it never plays on their behalf and never modifies data
- Records older than the data source's retention window cannot be fetched — the interface shows the earliest date still available
- Clicking the download button for the user: not possible, and not planned
- It does not analyse: analysis belongs to RealtimeGTO or to the user's own tools
- It does not guarantee complete downloads: that is exactly why verification and repair exist
