# Knock React Inbox components and user identity in Cadence

Research for [#6](https://github.com/Oscar1996/ai-project/issues/6) (map [#5](https://github.com/Oscar1996/ai-project/issues/5)). Researched 2026-11-15.

**Question:** What do Knock's React SDKs offer for an in-app **Inbox**, how do they behave under React Router framework mode with SSR, and how is a Cadence user identified to Knock — including under Cadence's dev user-switcher?

## Answer in brief

- Use **`@knocklabs/react` 0.15.1**. It ships a ready-made bell (`NotificationIconButton`), popover (`NotificationFeedPopover`), and feed (`NotificationFeed`). The same package re-exports headless hooks from `@knocklabs/react-core` (`useKnockFeed`, `useNotifications`, `useNotificationStore`, `useKnockClient`). Cadence can start with the ready-made components and drop to hooks later without changing packages.
- Theming is plain CSS: a global stylesheet with `--rnf-*` variables and `rnf-*` classes, plus a `colorMode` prop that is `"light"` or `"dark"`. There is no Tailwind or shadcn integration, so matching Cadence's look means overriding CSS variables or using `renderItem`.
- Real-time updates come over a websocket by default. Each item has `seen_at`, `read_at`, `interacted_at`, and `archived_at`. The badge counts **unseen** items by default. The popover marks everything seen when it opens, and clicking a cell marks it interacted, **not read**.
- **SSR matters.** `KnockProvider` builds the client and calls `authenticate()` inside `useMemo`, so the call also runs on the server. With the default `identificationStrategy: "inline"`, every server render would make an identify request. Plan to render the Knock subtree only after hydration, or keep `enabled` false until then. Also identify users from the server with `identificationStrategy: "skip"`.
- **Identity.** The client gets the public key plus `user={{ id }}`. With **enhanced security mode** (the docs recommend it before going live), it also needs a signed RS256 user-token JWT, which the server produces with `signUserToken(userId, { expiresInSeconds })` from `@knocklabs/node/lib/tokenSigner` (`@knocklabs/node` 1.41.1). The token needs `KNOCK_SIGNING_KEY`, a secret that must stay on the server.
- **Dev user-switcher.** This works without extra code. If the app layout loader returns the Knock user id and token, switching users makes the loader run again. `KnockProvider` then re-authenticates the existing client in place and tears down and rebuilds real-time connections, and `KnockFeedProvider` remounts because its React `key` includes the user id.

## Packages and versions (npm, checked 2026-11-15)

| Package | Version | Role |
| --- | --- | --- |
| `@knocklabs/react` | 0.15.1 | Ready-made components (feed, popover, bell, guides, Slack/Teams); re-exports all of `react-core` |
| `@knocklabs/react-core` | 0.17.1 | Providers and headless hooks (depends on `swr`, `@tanstack/react-store`, `date-fns`) |
| `@knocklabs/client` | 0.23.1 | Framework-agnostic JS client: `Knock`, `Feed`, websocket (`phoenix` 1.8.9) |
| `@knocklabs/node` | 1.41.1 | Server SDK: triggering workflows, identifying users, `signUserToken` (uses `jose`) |

Source: `npm view <pkg> version`.

Peer dependencies of `@knocklabs/react` are React and React DOM `^17 || ^18 || ^19`, so Cadence's React 19.2.7 is compatible. `next` and `@tanstack/react-router` are optional peers, used only by the `./next` and `./tanstack` subpath exports. Those exports provide `KnockGuideLocationSensor` for Guides, which is not part of the Inbox. Source: `npm view @knocklabs/react peerDependencies peerDependenciesMeta exports`.

The package declares no React Router integration. None is needed for the feed. Note that Cadence runs **React Router 8.3.0** (see `package.json`), not v7.

## Ready-made components vs headless hooks

The ready-made components are exported from `@knocklabs/react` (source: `dist/types/index.d.ts`, `dist/types/modules/feed/**`):

- **`KnockProvider`** takes `apiKey` and `user` (`{ id, ...properties }`). The older `userId` prop is deprecated. It also takes `userToken`, `onUserTokenExpiring`, `timeBeforeExpirationInMs`, `identificationStrategy` (`"inline" | "skip"`), `enabled`, `i18n`, `host`, `logLevel`, and `branch`.
- **`KnockFeedProvider`** takes `feedId` (the in-app feed channel id), `colorMode`, and `defaultFeedOptions`. The options include `status`, `archived: "include" | "exclude" | "only"`, `page_size`, `tenant`, `workflow_categories`, `mode: "compact" | "rich"`, and `__experimentalCrossBrowserUpdates`.
- **`NotificationIconButton`** is the bell. It takes `onClick` and `badgeCountType` (`"unseen"` by default, or `"unread"` / `"all"`) and forwards a ref to its button.
- **`NotificationFeedPopover`** takes `isVisible`, `onClose`, `buttonRef`, `onOpen({ store, feedClient })`, `closeOnClickOutside`, and a popper `placement`, plus every `NotificationFeed` prop.
- **`NotificationFeed`** can be placed inline, for example on a full Inbox page. It takes `renderItem`, `renderHeader`, `EmptyComponent`, `onNotificationClick`, `onNotificationButtonClick`, `onMarkAllAsReadClick`, `initialFilterStatus`, `renderLoading`, and `formatTimestamp`.
- Smaller exports: `NotificationCell` (with its archive "x" button and `Avatar`), `MarkAsRead`, `UnseenBadge`, `EmptyFeed`, and `NotificationFeedContainer`.

Setup follows [docs.knock.app/in-app-ui/react/feed](https://docs.knock.app/in-app-ui/react/feed):

1. Import `@knocklabs/react/dist/index.css`.
2. Wrap the layout in `KnockProvider` and the feed in `KnockFeedProvider`.
3. Render the bell plus the popover, managing `isVisible` and `onClose` yourself.

Headless use is described at [docs.knock.app/in-app-ui/react/headless/feed](https://docs.knock.app/in-app-ui/react/headless/feed):

1. Call `useKnockClient()`, then `useNotifications(knock, channelId, options)` to get a `Feed`, then `useNotificationStore(feed)` for `{ items, metadata }`.
2. Call `feed.fetch()` in an effect.
3. Render `item.blocks[0].rendered`, which is HTML.

The docs warn: you are "responsible for marking items as seen" headless. If you don't, `unseen_count` never drops.

## Theming and styling

- The stylesheet is a single global `dist/index.css` (about 67 KB). It defines `:root` design tokens prefixed `--knock-*`, about 92 `--rnf-*` variables (for example `--rnf-color-brand-500`), and classes prefixed `rnf-`. Each component has a `--dark` modifier class. Source: `@knocklabs/react/dist/index.css`.
- The docs suggest three ways to customise: override `--rnf-*` variables, replace the stylesheet entirely (every class starts with `rnf-`), or use `renderItem` and `renderHeader` for custom markup ([react/feed docs](https://docs.knock.app/in-app-ui/react/feed)).
- **Dark mode** is the `colorMode="dark"` prop on `KnockFeedProvider`. It does not follow a CSS class on `<html>`. Cadence toggles dark mode by adding a `dark` class from `localStorage` in a script in `app/root.tsx`, so the app would need to read that state and pass it to `colorMode`.
- Components are built on Knock's "Telegraph" design system (`@telegraph/*` dependencies) and `@radix-ui/react-dialog` / `react-hover-card`. They are not shadcn components.

## Read, unseen, archived state and marking

The `FeedItem` fields are `seen_at`, `read_at`, `interacted_at`, and `archived_at`. `FeedMetadata` is `{ total_count, unread_count, unseen_count }`. Source: `@knocklabs/client` `dist/types/clients/feed/interfaces.d.ts`.

`Feed` methods (source: `clients/feed/feed.d.ts`):

- Mark items: `markAsSeen` / `markAsUnseen`, `markAsRead` / `markAsUnread`, `markAsInteracted(items, metadata?)`, and `markAsArchived` / `markAsUnarchived`.
- Mark in bulk: `markAllAsSeen`, `markAllAsRead`, `markAllAsArchived`, and `markAllReadAsArchived`.
- Fetch: `fetch` and `fetchNextPage`.

All of these update the store optimistically. They do nothing when no user is signed in.

Ready-made components apply some marks automatically:

- Opening the popover calls `markAllAsSeen`. The docs say: "By default the feed will mark all items as seen when the feed popover opens."
- Clicking a `NotificationCell` calls `markAsInteracted`. Verified by grepping the built `NotificationCell.mjs` and `NotificationFeedPopover.mjs`.
- Marking an item **read** is up to Cadence, for example `feedClient.markAsRead(item)` in `onNotificationClick`. Another option is the "Mark all as read" header button.
- The cell's "x" archives the item. Archived items are hidden by default (`archived: "exclude"`).

Status meaning ([message statuses](https://docs.knock.app/send-notifications/message-statuses)): seen means the message was fetched for display at least once, which is different from read. The default badge counts unseen items, so it clears when the user opens the feed.

## Real-time updates

- `@knocklabs/client` opens a Phoenix websocket when `window` and `WebSocket` exist. It reconnects when the browser comes back online and, by default, disconnects tabs that are hidden. Source: `dist/esm/api.mjs`, `pageVisibility.mjs`.
- Each `Feed` subscribes with `listenForUpdates()` and emits events through `on` / `off`.
- `defaultFeedOptions.__experimentalCrossBrowserUpdates` syncs tabs through BroadcastChannel ([react/feed docs](https://docs.knock.app/in-app-ui/react/feed)).
- No polling or SSE setup is needed on the Cadence side.

## SSR and React Router framework mode

- Cadence runs with `ssr: true` (`react-router.config.ts`).
- `@knocklabs/react`'s ESM entry starts with `"use client"`. That directive only means something to React Server Components, and React Router framework mode does not use RSC by default.
- The client guards its browser globals with `typeof window` / `typeof document` checks, so importing it on the server should not crash. This is from reading the bundle only. The SSR smoke test was not run because the sandbox blocked package installation.
- **Server-side side effects.** `KnockProvider` calls `useAuthenticatedKnockClient`. That hook creates `new Knock(...)` and calls `authenticate()` inside `useMemo`, which runs during SSR too.
  - With the default `identificationStrategy: "inline"` and a `user` object, `authenticate` fires `user.identify(...)`, an HTTP request to Knock.
  - So every server render would make an identify call from the Node process, and possibly another from the browser on hydration.
  - Sources: `@knocklabs/react-core` `dist/esm/modules/core/hooks/useAuthenticatedKnockClient.mjs`; `@knocklabs/client` `dist/esm/knock.mjs` (`authenticate`).
- **Recommendation for Cadence:**
  - Render the Inbox subtree (provider, bell, and popover) only after hydration, using a small `useHydrated` / `ClientOnly` gate. Cadence has none today; `monaco-markdown-editor.tsx` uses dynamic `import()` for a similar reason. Alternatively, pass `enabled={hydrated && Boolean(userId && token)}`.
  - The bell then appears after hydration, so reserve its space in the sidebar to avoid layout shift.
  - Pass `identificationStrategy="skip"` and identify users on the server with `@knocklabs/node`. This keeps the browser from upserting user properties and keeps identify inside Cadence's trust boundary.
- No `clientLoader` is needed. The token can come from the normal server `loader`.

## Identifying users and enhanced security mode

Sources for this section: [docs.knock.app/in-app-ui/security-and-authentication](https://docs.knock.app/in-app-ui/security-and-authentication) and `@knocklabs/node` `lib/tokenSigner.d.mts`.

- **Without enhanced security**, the browser needs only the public API key and the user id. Anyone holding the public key can read any user's feed by changing the id. That is acceptable only in development.
- **With enhanced security mode** (off by default; "recommended before going live"), Knock rejects client requests that carry only the public key. Each request must also send a **user token**:
  - The token is a JWT signed with **RS256**.
  - `sub` holds the user id and is required. `iat` and `exp` are recommended.
  - `grants` is optional. Without `explicit_grants: true`, the token has access to all resources by default.
- **Producing the token on the server:**
  - Call `import { signUserToken } from "@knocklabs/node/lib/tokenSigner"`, then `await signUserToken(String(user.id), { expiresInSeconds })`.
  - Other options are `signingKey`, which defaults to `process.env.KNOCK_SIGNING_KEY`; `grants`; and `shouldGenerateJti`. The default lifetime is 3600 seconds.
  - The signing key comes from Dashboard › Platform › API keys and is shown once. Prefer the single-line base-64 PEM format.
- **Passing the token to the client.** In React, pass `userToken={token}` to `KnockProvider`. Knock advises matching the token's expiry to the session's expiry, or using a short lifetime with `onUserTokenExpiring` (`(currentToken, decoded) => Promise<string | void>`) that fetches a fresh token. That needs a small resource route such as `api.knock-token.ts`.
- **Loading the token asynchronously.** `KnockProvider`'s `enabled` prop lets the app wait until both the id and the token exist, without 401s. The README says to use it "instead of conditionally mounting `KnockProvider`" (`@knocklabs/react` README; prop JSDoc in `KnockProvider.d.ts`).
- **Ids.** Cadence user ids are integers (`users.id`), while Knock ids are strings, so use `String(user.id)` consistently on both the server and the client.

## Interaction with the dev user-switcher

Cadence files involved: `app/routes/api.switch-user.ts`, `app/lib/session.ts`, `app/routes/layout.app.tsx`, and `app/components/dev-ui.tsx`.

1. The switcher posts to `/api/switch-user`. That route writes `userId` into the `cadence_session` cookie and redirects. React Router then runs the loaders again, including `layout.app.tsx`, which already loads the current user and renders `DevUI`.
2. If that loader also returns `knockUserId` and a freshly signed `knockToken`, the new props reach `KnockProvider`. In `useAuthenticatedKnockClient`, a changed id or token on an authenticated client calls `authenticate()` on the **same** client instance. The client logs "userId or userToken changed; reinitializing connections", tears down feeds and the API client, and reinitializes the sockets (`knock.mjs`).
3. `KnockFeedProvider` passes a React `key` built from `knock.userId`, `feedId`, and the options (`feedProviderKey`), so the feed store remounts and the previous user's items cannot leak into the new user's view.
4. When nobody is selected (logged out, the "Select a user from the DevUI panel" state), pass `enabled={false}`. The client then disconnects and clears its data "like a logout".
5. Because the token is signed per request in the loader, switching users needs no extra auth endpoint. The real login (`login.tsx`, email only) and `api.logout.ts` go through the same session path, so they behave the same way.

## Surprises and open points for the map

- **Shared Knock environment across developers and reseeds.** Cadence ids are SQLite autoincrement integers. `npm run db:seed` and every other developer's local database reuse ids such as `1`, `2`, `3`. If they share one Knock development environment, user "1" would see notifications sent to every developer's "1", including ones from before a reseed. This belongs in the existing "Knock environments and secrets" open point, perhaps with a per-developer id prefix or a separate environment per developer.
- **SSR side effect.** The provider makes network calls during render, as described above. The Inbox needs a client-only gate. This was not stated in Knock's docs; it comes from the source.
- **Enhanced security is a dashboard setting, per environment.** Production needs `KNOCK_SIGNING_KEY` on the server. Local development can leave the mode off and skip tokens, which means code paths that work with and without a token.
- **Server-side identify.** Recipients probably need to be identified with `@knocklabs/node` before or when a workflow is triggered, so that names render in templates. That fits the planned thin send wrapper, and tests must fake it too.
- **Restyling.** To match Cadence's shadcn/Tailwind look, expect CSS-variable overrides or a `renderItem`, or a headless Inbox. Dark mode must be passed as `colorMode`.
