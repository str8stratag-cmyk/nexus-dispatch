# Dispatch Monitor

Radio-transcription dispatch board. Fleet setup, device identity, and the
release-branch rules live in `AGENTS.md`. This file documents the
live-location check-in gate.

## Live-location check-in

A driver checks in by sharing a Telegram **Live Location** in the dispatch
group, or privately with the bot. The bot replies:

`✅ <name> checked in — receiving calls.`

Later GPS edits of that live message update the stored fix and do not send
another reply. The reply is sent again only when a stopped, expired, or stale
share becomes active again.

What is stored, per driver, in MongoDB collection `driverLiveGate` (plus the
existing `driverLocations` history):

- latest coordinates, live period, and the time of the last fix
- whether the share is still live
- an explicit stop (`edited_message` whose location has no `live_period`)
- expiry (`live_period` elapsed; "Until I turn it off" does not expire on a timer)
- check-in, warning, and removal clocks

A one-shot location pin is not a check-in.

Dispatch alerts are unchanged: a new call is still posted to the group with
the Accept button. This gate does not DM offers or pick a nearest driver.

## Continuous membership gate

`DRIVER_LIVE_GATE` is **off by default**. Nothing below runs until it is turned
on, and only on the one process that already receives Telegram updates.

While it is on:

1. **Join requests.** Drivers join DISPATCH RELAY through an invite link that
   asks for admin approval. The bot approves `chat_join_request` for
   `TELEGRAM_CHAT_ID` (the DISPATCH RELAY supergroup, `-1003976442204`).
   It posts a short welcome telling them to share Live Location.
2. **10 minutes to share.** A new member who does not start a live share
   within `DRIVER_JOIN_GRACE_MIN` (default 10) is removed. Removal is
   `banChatMember` + `unbanChatMember`, so they can request to join again.
   The clock starts when the bot approves them, not when they originally
   requested.
3. **Share stops.** If a checked-in driver's live location stops, the live
   period ends, or the last fix is older than `DRIVER_LIVE_STALE_MIN`
   (default 15), the bot warns once, in the group:

   `Your location stopped — re-share within 5 min or you'll be removed`

   The "5" is `DRIVER_RESUME_GRACE_MIN` (default 5). The warning is posted in
   the group. If the live share itself was sent privately to the bot, the same
   sentence is also sent in that chat. If they do not re-share in that window,
   they are removed the same way. Re-sharing clears the warning. A later stop
   warns once more.
4. **Who is not removed.** `DRIVER_LIVE_EXEMPT_IDS` and `TELEGRAM_ADMIN_IDS`
   are never warned or removed. Chat admins and anyone already out of the
   group are skipped after Telegram says so. People who were already in the
   group when the flag was turned on are not kicked for never sharing; the
   10-minute rule is for new join approvals. Once they check in, a later
   stop follows the warning rule.

The sweep runs about every 20 seconds on the receiver, so a deadline lands
within one sweep of the configured minute.

People who only ever send a static pin, or who share in some other chat, are
ignored.

## Config

Set these in the desk's `.env` (never commit that file). Defaults match
`.env.example`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DRIVER_LIVE_GATE` | off | `1` turns the gate on. Anything else is off. |
| `DRIVER_JOIN_GRACE_MIN` | `10` | Minutes after approval to start Live Location. |
| `DRIVER_LIVE_STALE_MIN` | `15` | Minutes without a new fix before the share is stale. |
| `DRIVER_RESUME_GRACE_MIN` | `5` | Minutes after the warning before removal. |
| `DRIVER_LIVE_EXEMPT_IDS` | empty | Comma-separated Telegram user ids. Never warned or removed. |
| `TELEGRAM_BOT_TOKEN` | | Existing bot token. Not repeated here. |
| `TELEGRAM_CHAT_ID` | | Dispatch group. Gate ignores every other chat. |
| `TELEGRAM_ACCEPT_POLL` | off | `1` on exactly one desk (Disp-1). That desk runs this gate too. |
| `TELEGRAM_ADMIN_IDS` | | Also exempt, and still the only users who may `/remove` and `/where`. |

`DRIVER_LOCATION_GATE` is a different switch (daily check-in button and Accept
eligibility). Turning it on does not turn this gate on.

A value of `0` or a non-positive number for a timing falls back to the default.
The gate will not run with a zero-minute deadline.

## Rollout

1. Leave the flag unset everywhere until this is reviewed.
2. On **Disp-1 only** (the desk that already has `TELEGRAM_ACCEPT_POLL=1`),
   set `DRIVER_LIVE_GATE=1` and any timing or exempt overrides. Do not set the
   flag on Disp-2..5. Two receivers would approve and remove twice; the poller
   lock already forbids that, and this sweep is started only on that same
   receiver (or on the single host that sets `TELEGRAM_WEBHOOK_URL`).
3. Confirm the bot is an admin in DISPATCH RELAY with **Invite users via
   link** (so it can approve join requests) and **Ban users**.
4. Point drivers at a join-request invite link, not an open link. Requests
   that arrive while the flag is off stay pending; they are not consumed.
5. Restart the Disp-1 app so the poller asks Telegram for `chat_join_request`.
   The log line `live-gate: true` means this process will run the sweep.
6. Join with a test account, approve should be automatic, and skipping Live
   Location should remove the account after the join grace. Sharing Live
   Location should produce the check-in reply. Stopping it should warn once,
   then remove after the resume grace.

Calls continue to post to the group either way. Turning the flag back off
and restarting stops approvals, warnings, and removals. It does not delete
`driverLiveGate` documents.
