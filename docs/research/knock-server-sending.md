# How a Cadence server sends Notifications through Knock

Research for [issue #7](https://github.com/Oscar1996/ai-project/issues/7), part of map [#5](https://github.com/Oscar1996/ai-project/issues/5). Researched 2026-11-15 from Knock's docs, the published `@knocklabs/node` type definitions, npm, and the pricing page.

## TL;DR

- Server code calls `knock.workflows.trigger(workflowKey, { recipients, actor, data, tenant, cancellation_key })` from **`@knocklabs/node` (v1.41.1)**, authenticated with an environment **secret key** (`sk_…`, env var `KNOCK_API_KEY`). The call returns `{ workflow_run_id }` and the run executes asynchronously, so a successful trigger does not mean the message was delivered.
- Recipients and the actor can be **identified inline** by passing objects such as `{ id, name, email }` instead of ID strings. That means no separate user-sync step is needed to start.
- Failures throw typed `APIError` subclasses. The SDK's defaults are a **60 s timeout and 2 retries**. A best-effort wrapper should lower both and catch everything.
- Workflows **can live in the repo as code**: `knock workflow pull/push`, with `--commit`, then `knock commit promote --to=production`. The CLI and Management API are authenticated with a **service token** (`knock_st_…`), never with API keys.
- Environments: production always exists, and development is added when environments are enabled. Custom environments such as staging are allowed. Users, messages and keys are isolated per environment. Workflows are versioned with commits.
- The in-app feed uses a **public key** (`pk_…`) plus a feed **channel ID** in the browser. Production should turn on **enhanced security mode**, where the server signs a per-user JWT with `signUserToken` and `KNOCK_SIGNING_KEY`.
- A **batch function** collapses noisy events per recipient, with an optional batch key such as a course ID.
- Free plan: **10,000 messages a month**, unlimited environments and workflows, 30-day log retention, no hard cap.

## 1. Triggering a workflow from Node

Package: `@knocklabs/node`, latest version **1.41.1** (npm, published 2026-11-10). Its only runtime dependency is `jose`. It needs Node 20 LTS or later and TypeScript 4.9 or later. Repo: <https://github.com/knocklabs/knock-node>.

```ts
import Knock from "@knocklabs/node";
const knock = new Knock(); // reads process.env.KNOCK_API_KEY (secret key); KNOCK_BASE_URL overrides https://api.knock.app

const { workflow_run_id } = await knock.workflows.trigger("refund-requested", {
  recipients: [{ id: "user_42", name: "Ada", email: "ada@example.com" }], // inline identify, or plain "user_42"
  actor: "user_7",                     // who did it
  data: { courseId: 3, courseTitle: "…" },
  tenant: "team_9",                    // optional; scopes feed messages
  cancellation_key: "refund-123",      // optional; enables later cancel
});
```

Sources: `resources/workflows.d.ts` and `client.d.ts` in the published `@knocklabs/node@1.41.1` tarball; [Trigger API docs](https://docs.knock.app/send-notifications/triggering-workflows/api); [knock-node README](https://github.com/knocklabs/knock-node/blob/main/README.md).

Trigger parameters, all from `WorkflowTriggerParams` in the SDK types and the trigger docs:

| Field | Notes |
| --- | --- |
| `recipients` (required) | Each entry is one of: a user ID string, an inline user object (`{ id, ...props }`), or an inline object (`{ id, collection }`). **Maximum 1,000 recipients** per call. The API has no bulk trigger. |
| `actor` | A user ID or inline user. It is recorded on feed messages, exposed to batch steps as `actors`, and **excluded from notifications when recipients are subscribers of an object**. When recipients are listed directly, Cadence still has to drop the actor itself to honour the "never notified about own action" rule. |
| `data` | A JSON object, up to **10 MB**. Strings over 1,024 bytes are truncated in logs only. Data is available in templates and as feed message custom properties, which can be filtered on. |
| `tenant` | A string or inline tenant. It scopes in-app feed messages. Teams could map to tenants, but Cadence does not need this. |
| `cancellation_key` | Needed to cancel the run later. Should be unique per trigger. |
| `settings` | `{ sandbox_mode, skip_delay }`. Sandbox mode skips delivery to providers. |
| `Idempotency-Key` header | Retries that reuse the same key within 24 h return the original response. |

- **Asynchronous:** the SDK doc comment says "All workflow runs are executed asynchronously." A 200 response means the run was accepted, not delivered.
- **Inactive workflow:** a trigger to an inactive workflow returns a `workflow_inactive` error and creates no runs ([Triggering workflows](https://docs.knock.app/send-notifications/triggering-workflows)).
- **Preferences:** "Knock handles all preference-based opt-outs automatically." This is irrelevant while preferences are out of scope.

### Cancellation

`knock.workflows.cancel(workflowKey, { cancellation_key, recipients? })` cancels a run only while it is paused in a **batch, delay, wait-for-event or fetch-retry** step. Notifications with no such step are sent immediately and cannot be cancelled. Knock recommends waiting at least 5 s after the trigger before cancelling. A message already in the feed cannot be cancelled; archive it instead. Feed messages are immutable. ([Canceling workflows](https://docs.knock.app/send-notifications/canceling-workflows), [Feeds overview](https://docs.knock.app/in-app-ui/feeds/overview))

### Inline identify vs separate user sync

Knock offers three ways to identify users. All of them upsert, merging new properties into existing ones ([Identifying recipients](https://docs.knock.app/managing-recipients/identifying-recipients)):

- **Inline:** pass recipient objects in the trigger. Plain ID strings do not identify anyone. Only `id` is required. `name` is reserved, and `email` and `phone` are needed only by those channels.
- **Direct:** `PUT /v1/users/{id}` (`knock.users.update`), for when a user signs up or their details change.
- **Bulk:** `POST /v1/users/bulk/identify`, for imports.

For an in-app-only Cadence, sending `{ id, name }` inline on every trigger keeps Knock up to date without a sync job. The Knock user ID should be the Cadence user ID. The browser feed also needs the user to exist; inline identification on first trigger handles that, and so does `authenticate`, which client-side identifies users.

### Error shapes and timeouts

From the SDK README and `client.d.ts`:

- Every failure throws a subclass of `Knock.APIError` that carries `status`, `name` and `headers`: `BadRequestError` (400), `AuthenticationError` (401, for example a revoked key), `PermissionDeniedError` (403), `NotFoundError` (404, for example an unknown workflow key), `UnprocessableEntityError` (422), `RateLimitError` (429) and `InternalServerError` (5xx). A failed connection throws `APIConnectionError`, and a timeout throws `APIConnectionTimeoutError`.
- **Defaults are `timeout` 60,000 ms and `maxRetries` 2**, with exponential backoff on connection errors, 408, 409, 429 and 5xx. Both can be set on the client or per request. The types note that timeouts are retried, so the worst case is far longer than one timeout.
- **Implication for best-effort sends:** construct the client with something like `{ timeout: 3000, maxRetries: 0 or 1 }`, catch and log every error, and avoid `await`ing the trigger on the request's critical path (or await it inside a catch-all). Otherwise a Knock outage could stall a Cadence action for minutes.
- Rate limits are per environment for secret-key requests, with endpoint tiers of 1, 5, 60, 200 and 1,000 requests per second. The trigger endpoint's tier was not shown in the fetched page ([Rate limits](https://docs.knock.app/api-reference/overview/rate-limits)).

## 2. Workflows as code: CLI and Management API

Workflows do not have to be dashboard-only.

- **CLI:** `@knocklabs/cli` **v1.6.2** (npm) or `brew install knocklabs/tap/knock`. It authenticates with `knock login` (browser) or a **service token** passed as `--service-token`, or stored in `~/.config/knock/config.json`. A `knock.json` file sets `knockDir`, and commands must be run from the directory that holds it ([CLI overview](https://docs.knock.app/cli/overview)).
- **Workflow commands:** `new`, `list`, `get`, `pull`, `push`, `validate`, `activate`, `run`, `generate-types` (generates TypeScript types for trigger `data`, which is useful for a typed wrapper) and `open` ([CLI workflow](https://docs.knock.app/cli/workflow)).
- **On-disk layout:** one directory per workflow key, holding `workflow.json` and one folder per channel step, with templates extracted to files. For example, `in_app_feed_1/markdown_body.md`, and `email_1/visual_blocks.json` for email. `workflow.json` follows the Management API workflow schema ([CLI workflow](https://docs.knock.app/cli/workflow)).
- **`knock workflow push`** flags: `--environment` (defaults to the account default), `--commit` with `-m`, `--all` with `--workflows-dir`, `--branch` and `--force`. If you `--force` into a non-development environment, you should also commit ([workflow push](https://docs.knock.app/cli/workflow/push)).
- **Promotion:** `knock commit promote --to=production` promotes all new commits from the preceding environment, while `--only=<commit-id>` promotes one commit. `--force` skips the confirmation prompt, which suits CI ([commit promote](https://docs.knock.app/cli/commit/promote)).
- **Management API:** `https://control.knock.app/v1`, using Bearer service-token auth. It covers workflows and templates, layouts, translations, partials, and commits (including commit and promote). Knock warns that "environment-level API keys should never be used to authenticate with the management API." The Node client is `@knocklabs/mgmt` (v0.46.1, repo `knocklabs/knock-mgmt-node`) ([MAPI reference](https://docs.knock.app/mapi-reference)).

A workable repo flow: keep `knock/workflows/<key>/…` in git, run `knock workflow push --all --commit` to development, then `knock commit promote --to=production` on release.

## 3. Environments and keys

From [Environments](https://docs.knock.app/concepts/environments), [API keys](https://docs.knock.app/developer-tools/api-keys), [Service tokens](https://docs.knock.app/developer-tools/service-tokens) and [Security and authentication](https://docs.knock.app/in-app-ui/security-and-authentication):

- Every account starts with **production**. Enabling environments adds **development**, and custom environments (for example staging) can be inserted between them. Neither default can be deleted.
- **Users, tenants, objects, messages, logs and API keys are isolated per environment.** Workflows, layouts, partials and translations are **version-controlled with commits** and promoted up the chain. The "Modify resources in any environment" setting is on by default; turning it off forces work to happen in development and be promoted.

| Credential | Prefix | Scope | Used where |
| --- | --- | --- | --- |
| Secret API key | `sk_` | Per environment | Cadence server only (`KNOCK_API_KEY`), for trigger, identify and cancel. Never shipped to the client. |
| Public API key | `pk_` | Per environment | Browser feed client (`KnockProvider` / `@knocklabs/react`, currently v0.15.1). |
| Signing key | PEM | Per environment | Server-side `signUserToken(userId, { expiresInSeconds })`, exported from `@knocklabs/node`. Reads `KNOCK_SIGNING_KEY` and signs locally with RS256, with no network call. The default expiry is 3600 s. |
| Service token | `knock_st_` | Account (inherits the creating owner/admin) | CLI, Management API and MCP. Never works with the regular API. |

- **Enhanced security mode** is **off by default**. While it is off, anyone holding the public key can read any user's feed. Knock says to enable it "before you go live." Leaving it off in development is acceptable.
- Revoking a key takes effect immediately and returns 401.
- Each environment can have unlimited keys. Keys cannot be scoped to a subset of resources.

## 4. In-app feed channel

From the [Feeds overview](https://docs.knock.app/in-app-ui/feeds/overview) and [In-app UI overview](https://docs.knock.app/in-app-ui/overview):

- Knock **creates one in-app channel by default**. More channels can be added for multiple feeds. A workflow adds an **in-app feed channel step** whose template is a markdown body plus an action URL.
- The client fetches messages through the client API with the public key, user, and feed channel ID, gets real-time updates over Knock's managed websocket, and tracks seen, read, interacted and archived state, including badge counts.
- Feeds are newest first and cannot be pinned. They can be filtered by status or by trigger `data` properties.
- Messages are **immutable** after generation. To update one, archive it and trigger again.
- Free-plan feed retention is unlimited and configurable.

## 5. Batching (noisy events)

From the [Batch function](https://docs.knock.app/designing-workflows/batch-function) docs:

- A batch step is **per recipient**. Triggers that arrive while a batch is open are folded into it as `activities`, and their own runs terminate.
- Windows can be fixed, dynamic (from data or rules), relative, or sliding with a required maximum extension. A batch stays open for at most 90 days. It can close early at an activity cap of 2–1,000.
- A **batch key** (for example `data.courseId`) groups activities so each key gets its own notification. Knock's own example is exactly "many comments" on one page.
- Templates receive `total_activities`, `total_actors`, and up to **10** `activities` and `actors` (first or last 10). Raising this render limit to 100 is an **Enterprise** feature. After a batch, `data` is flattened to scalars, with strings capped at 256 characters and the latest value winning.
- Batch steps also make runs cancellable while the window is open.

## 6. Free-tier limits

From [knock.app/pricing](https://knock.app/pricing):

- **Free plan, $0/month:** 10,000 messages a month, where a message is one delivery to one user on one channel; failed or bounced messages don't count. In-app feed deliveries are a channel delivery and so presumably count. The plan also includes 500 guide recipients, unlimited environments, workflows, triggers and members, 30-day log retention, and Knock branding.
- **No hard cap:** Knock contacts you about billing the following month.
- **Next tier:** Starter, $250/month for 50k messages, then $0.005 per message.

## Packages and versions (npm, 2026-11-15)

- `@knocklabs/node` 1.41.1: server SDK, including `signUserToken`.
- `@knocklabs/react` 0.15.1: in-app feed UI.
- `@knocklabs/cli` 1.6.2: CLI.
- `@knocklabs/mgmt` 0.46.1: Management API client.

## Open points / not verified

- The rate-limit tier of the trigger endpoint.
- Whether feed messages count toward the 10k message quota. The pricing wording implies they do.
- Whether CLI pushes are restricted to development when "Modify resources in any environment" is off. The docs imply yes but don't state it on the push page.
