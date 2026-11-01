# PRD: Group Reading Sync

Nov 1, 2026 · @Moshe Winberg

## Overview

The system is two independent products: a **reading app** that displays a sequence of text pages defined by JSON, and a **sync service** that lets an ad-hoc group follow one leader's position in real time. The reading app is the sync service's first customer, using only what any other client app could use.

The core principle: **the sync service syncs a position, not a page.** It stores and broadcasts an opaque payload it never reads. It knows nothing about pages, books or content, which is what lets one service run many different client apps, each with many groups.

A second principle: **the leader's browser is the group's database.** The server keeps no persistent records. Everything needed to rebuild a group lives in signed tokens and in the leader's client.

## Goals and success criteria

v1 lets anyone start a reading group in seconds, keeps every member on the leader's page, and survives disconnects and server restarts without a database.

Goals:

- A client-agnostic sync service that any app can integrate through a package.
- A JSON-driven reading app that supports RTL, LTR and mixed-direction content.
- Groups that recover from leader disconnects, idle leaders and server restarts.
- Self-hostable with Docker Compose, configured by JSON files and env variables.

v1 is done when all three criteria hold:

| Criterion | Target |
| --- | --- |
| Time from opening the app to following the leader | Under 15 seconds |
| Time for members' screens to update after the leader moves | Under 1 second |
| Leader whose phone locks briefly | Returns to the same group, still leading |

The exact lock duration for the third criterion is an open question; 30 seconds is the working assumption.

## Users, settings and scale

The leader can be a teacher, a group leader, or simply the member who opened the group first, so leader flows cannot assume any training.

- **Setting:** both in the same room and remote. Joining must work by reading codes aloud and by scanning a QR code.
- **Devices:** mostly phones. Tablets and laptops are supported, with richer leader views on larger screens.
- **Group size:** medium. The client app sets a maximum, and a server env var caps it, protecting other groups on the same server.
- **Accounts:** none. Users get an optional display name, or a generated one.
- **Privacy:** nothing is saved on the server after a session. Users may include minors, so IPs and names stay out of logs.

## Product 1: the reading app

The reading app renders a sequence of pages whose text and display design both come from a JSON file, and it joins groups through the sync package like any other client.

### Content

- Content can be bundled with the app or fetched from a server. Both stay supported, because users will later upload their own JSON.
- Every content file declares its **schema version** from day one. The app declares which schema versions it can render.
- Every content file has a **content ID** and a **fingerprint** (a hash of the file), so leader and members can confirm they are reading the exact same thing.

### Text direction

- Direction is set at three levels: document, page and block. Blocks may use "auto" to detect their own direction.
- The app interface and the content are independent. A Hebrew interface can show English text, and the reverse.
- Page-turn direction follows the document's direction. In an RTL book, "next" moves leftward and swipes reverse.

### Follower experience

- Members browse freely. When the leader moves, members who are elsewhere get an in-app prompt to jump to the group's page.
- The prompt always points to the group's official page, never to a page the leader is only previewing.
- Late joiners get a prompt with a countdown. The default when it ends is jumping to the leader's page.
- A connection indicator shows following, reconnecting, or leader offline.

### Content mismatch

- Unsupported schema version: blocked.
- Fingerprint differs from the leader's: if the content source keeps old versions, the app loads the leader's exact version. Otherwise it warns, or blocks if the version is no longer supported.

## Product 2: the sync service

The sync service runs isolated, ephemeral groups in which one leader broadcasts a position to all members, and it never interprets that position.

### Synced state

- The leader sends an opaque payload on every navigation. Client apps put whatever they need inside it, including their own flags.
- Group metadata (content ID, fingerprint, schema version) is stored and passed to members, but never read by the server.

### Joining

Each client app chooses which join methods it allows, from those the server env permits:

| Method | How it works |
| --- | --- |
| A. Group code + door code | Two 6-digit codes, always displayed, entered in order. The first identifies the group, the second admits. |
| B. Code + approval | One 6-digit code, then the leader approves each joiner. |
| C. Alphanumeric code | One 8-character code of letters and digits. |
| D. QR code | A long connection string with a timeout, for scanning in the same room. |

For method A, wrong door codes are rate-limited per group. After repeated failures the door code rotates or joining pauses.

### Roles

- **Leader:** broadcasts the position, can preview privately, remove members and lock the group.
- **Vice-leader:** a member the leader designates after people join. First in line to lead.
- **Member:** follows, browses freely, and can be removed.

At group creation, the leader chooses whether leadership passes automatically after the grace period, or the group stays frozen until they return.

### Leader view

- The leader always sees something: a counter on phones and tablets, and a list of names on laptops. Layout follows screen size, not device type.
- **Preview mode:** the leader can browse without moving the group. The screen shows both positions, such as "Group is on page 12, you're viewing page 15", with actions to bring the group there or return.

### Timers

Three timers govern a group. Client apps set their values, and server env vars cap them.

| Timer | Question it answers | Driven by |
| --- | --- | --- |
| Disconnection timeout | Is the leader still here? | The leader's connection |
| Inactivity limit | Is the session still going? | The leader's actions: page moves, previews, broadcasts |
| Max session time | Has the session run too long? | Time since creation |

Before the inactivity limit ends, the leader gets an in-app keep-alive prompt with a countdown. There are no native push notifications.

### Group lifecycle

A group ends when the leader ends it, when the max session time runs out, or when a keep-alive goes unanswered by both the leader and the next in line.

- **Leader disconnects or misses the keep-alive:** the group freezes for a grace period. If automatic handoff is on, leadership then passes to the vice-leader, or to the longest-connected member if there is none. The new leader's inactivity timer starts fresh.
- **New leader misses the keep-alive too:** the group closes when the countdown ends. Escalation goes one step only.
- **Original leader returns:** they rejoin the live group and get a prompt asking whether to take the lead back.
- **Someone becomes leader unexpectedly:** they get a clear "you're now leading" moment.

### Limits

To protect all groups on a server, client apps set a maximum group size and a maximum rate of leader updates. Server env vars cap both.

## Identity, tokens and recovery

Groups survive server restarts without a database, because every participant holds a signed token that lets the server rebuild the group when the leader returns.

### Tokens

- Each participant gets one JWT per group, stored in the browser. It is signed with a secret only the server knows.
- The token holds the group ID, the participant's ID and role, the group's creation time (for the max session time) and the last-activity time (for recovery).
- Last-activity is refreshed after a number of activities, bounded by a minimum and maximum interval between refreshes. Live activity is tracked in memory; the token value only matters after a restart.
- Token expiry is one year, as an outer safety net. The embedded timestamps do the real enforcement.

### Group IDs and codes

- The group ID is long and unguessable, separate from the join codes. Nobody types it.
- Clients send all their stored tokens for the current app; the server answers with the ones whose groups are live. Listing live groups is never possible.
- A recreated group keeps its old ID and its latest join codes. If the group code was taken in the meantime, the server issues new codes.

### Recovery after a restart

1. The server restarts and all in-memory groups are gone.
2. The leader returns with a valid leader token. The server verifies it and recreates the group with the same ID.
3. The leader's client sends its current position and block list, so the group resumes where it was.
4. Members return with valid member tokens and rejoin without entering codes.

Resuming a group later uses the same flow.

### Removed members

A token cannot revoke itself, so the block list lives in the leader's client. On recreation, the leader's client sends it, and the server refuses those member IDs.

## Multi-app isolation and versioning

Each client app is fully isolated on the server, and three version checks keep server, apps and content compatible.

### Client apps

- Each client app is identified by an API key and a namespace.
- Apps and groups are isolated from each other. No app can see or affect another app's groups, and no group can see another group.
- Each app's config sets its own values (join methods, group size, timers, update rate), always within the server's env ceilings.

### Version checks

| What is versioned | Declares | Enforced by |
| --- | --- | --- |
| Sync server protocol | Its version and the minimum client protocol it accepts | Server rejects older clients; client refuses unsupported servers |
| Client app | Its version; the app's server config sets the minimum | Server rejects app versions below the minimum, prompting users to update |
| Content schema | Each file's schema version; the app's supported range | Client app only. The server never reads it |

Content fingerprints are compared between leader and members by the client, as described in Product 1.

## Deliverables and operations

The sync service is treated as a product in its own right, designed first for self-hosting and later for a hosted offering.

### Deliverables

1. **Sync server**, run with Docker Compose.
2. **Framework-free JS package** (the core): sockets, reconnects, tokens, version checks and join flows for any client.
3. **React/Next package**: hooks and components on top of the core, safe during server-side rendering.
4. **Reading app**, its own Docker service, integrating only through the packages.

### Configuration

- Server behavior is set by JSON config files and env variables. Env variables define the ceilings for every client-set value.
- Client apps and their API keys are registered in server config for self-hosting.

### Storage

- Default: in-memory only. A restart drops live connections, and groups recover through tokens.
- Optional: Redis, still holding nothing beyond a group's life. It keeps groups live through restarts, allows several server instances, and can hold block lists server-side.
- No personal data is stored after a session. Names and IPs stay out of logs.

### Product readiness

- Public docs for the server and the packages, with the reading app as the working example.
- Health endpoint and clear startup errors for invalid config.
- Semantic versioning and a changelog.

## Out of scope and future work

v1 deliberately leaves out everything below; each item is a candidate for later versions.

- User accounts and persistent identity.
- Chat, reactions and annotations.
- Session history and analytics.
- Multiple simultaneous leaders.
- Native push notifications. All prompts are in-app.
- Inviting members of the leader's previous group who are on the app page. This needs presence outside groups and persistent identity.
- User-uploaded content. When added, uploaded JSON is untrusted input and must be validated against its declared schema.
- A hosted offering with self-service app registration.

### Open questions

- [ ] How long can a leader's phone stay locked and still count as "returning" for the success criterion?
- [ ] Exact default values and env ceilings for group size, update rate and all timers.
