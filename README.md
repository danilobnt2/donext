# Do Next

Do Next is a personal task app that moves outcome-based goals forward through small, timed actions, and catches procrastination early.

It is built around two kinds of work items:

- **To-Do**: an outcome you want to reach ("Get hired to a new job", "Plan dad's 70th birthday").
- **Task**: a small timed action that moves a To-Do forward ("Ask Marta for a referral", 10:00, 15 min).

The home screen answers one question: *what do I do next?*

## How it works

**To-Do states** are computed by the server from the To-Do's Tasks. Only Done and Abandoned are set by a person.

| State | Meaning |
| --- | --- |
| New | No Task has been done yet |
| Active | At least one Task done and at least one open |
| Pending | Every Task is done, but the To-Do is not. It needs a next Task or to be marked Done |
| Done | Goal reached; open Tasks close automatically |
| Abandoned | Hidden end state; history is kept |

**Tasks** are New or Done (or Abandoned). Rescheduling a Task requires a short reason. After completing a Task you are asked to add the next one or mark the To-Do done, so it never silently becomes Pending.

**History.** Every change is an append-only revision recording what changed, when, and who or what changed it (you, the system, or a named AI connector). Boards can be viewed as they were on a past date.

**Procrastination review.** Flags slipping items: overdue Tasks, Tasks rescheduled repeatedly, To-Dos stuck in Pending, Active To-Dos with no recent progress, and due dates closing in on unstarted To-Dos. For each flag you record whether the delay was genuine or procrastination. Thresholds are configurable (defaults: 30 min overdue grace, 2 reschedules, 3 days Pending, 7 days stale, 3-day due-soon window).

## Features

- To-Do board (New, Active, Pending, Done) and Tasks board (one swimlane per open To-Do)
- Push reminders before a Task, and when one passes without being done or rescheduled
- Private calendar feed (`.ics`) for Outlook, Apple Calendar and Google Calendar
- Passkey or email magic-link sign-in
- Multi-device with offline support; changes sync when back online
- AI connectors (Claude, ChatGPT, Gemini or any MCP client) that can read boards and create, update, complete, reschedule or abandon items, with a scheduled review run from the assistant itself
- Optional in-app review using your own AI key, stored only on the device

## Architecture

Everything runs on Cloudflare.

- **Frontend**: static PWA on Pages, with a local IndexedDB copy and an offline change queue
- **Worker**: single entry point that authenticates requests and routes to the user's Durable Object
- **Durable Object** (one per user, SQLite-backed): that user's data, the write pipeline, live sync over WebSocket, reminder alarms, and push sending
- **D1**: accounts, passkeys, sessions and calendar feed tokens
- **Remote MCP server**: on the same Worker, using the Agents SDK and `workers-oauth-provider`

The backend never calls an LLM, so AI costs stay with the user's own assistant.

## Design

Screens are designed for mobile (390 px), tablet and desktop: Next up, To-Dos board, Tasks board, Reschedule (reason required), Task done / what next, Procrastination review, To-Do detail with history, and Settings and connections.

## Status

Planning stage. This repository starts with the product spec and app design; implementation follows.
