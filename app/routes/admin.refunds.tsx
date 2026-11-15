import { useEffect } from "react";
import { data, isRouteErrorResponse, Link, useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/admin.refunds";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { UserRole, users } from "~/db/schema";
import { db } from "~/db";
import {
  MAX_COMPLETED_LESSON_SHARE,
  MAX_WATCHED_HOURS,
  MAX_WATCHED_SECONDS,
} from "~/lib/refund-policy";
import {
  approveRefund,
  buildRefundDecisionEmail,
  declineRefund,
  listRefundsForReview,
  type CourseProgress,
  type RefundReviewItem,
  type ReviewFailure,
} from "~/lib/refund-review.server";
import { formatPrice } from "~/lib/utils";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { AlertTriangle, ReceiptText } from "lucide-react";

const refundDecisionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("approve"),
    refundId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("decline"),
    refundId: z.coerce.number().int(),
    note: z
      .string()
      .trim()
      .max(1000, "Keep the note under 1000 characters.")
      .optional(),
  }),
]);

const FAILURE_MESSAGES: Record<ReviewFailure, string> = {
  "not-found": "That refund no longer exists.",
  "not-requested": "That refund has already been decided.",
  "seat-claimed":
    "A team seat from this purchase has been claimed, so it cannot be refunded.",
};

function getUserById(id: number) {
  return db.select().from(users).where(eq(users.id, id)).get();
}

async function requirePlatformAdmin(request: Request) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to review refunds.", {
      status: 401,
    });
  }

  const currentUser = getUserById(currentUserId);

  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only platform admins can review refunds.", { status: 403 });
  }

  return currentUser;
}

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Review refund requests" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requirePlatformAdmin(request);
  return { items: listRefundsForReview(db) };
}

export async function action({ request }: Route.ActionArgs) {
  const admin = await requirePlatformAdmin(request);

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundDecisionSchema);

  if (!parsed.success) {
    return data(
      { error: Object.values(parsed.errors)[0] ?? "Invalid input." },
      { status: 400 }
    );
  }

  const decision = parsed.data;
  const result =
    decision.intent === "approve"
      ? approveRefund(db, decision.refundId, admin.id)
      : declineRefund(db, decision.refundId, admin.id, decision.note || null);

  if (!result.ok) {
    return data({ error: FAILURE_MESSAGES[result.reason] }, { status: 409 });
  }

  // There is no mail transport yet, so the email goes to the server log.
  const email = buildRefundDecisionEmail(
    decision.intent === "approve" ? "approved" : "declined",
    result
  );
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);

  return {
    success:
      decision.intent === "approve" ? "Refund approved." : "Refund declined.",
  };
}

function formatHours(seconds: number) {
  const hours = seconds / 3600;
  return `${hours.toFixed(hours < 10 ? 1 : 0)} h`;
}

function Stat({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={
          warn ? "text-sm font-medium text-amber-600" : "text-sm font-medium"
        }
      >
        {value}
      </dd>
    </div>
  );
}

function ProgressBlock({
  title,
  progress,
}: {
  title: string;
  progress: CourseProgress;
}) {
  const share =
    progress.lessonsTotal > 0
      ? progress.lessonsCompleted / progress.lessonsTotal
      : 0;

  return (
    <div className="rounded-md border p-3">
      <h4 className="mb-2 text-sm font-semibold">{title}</h4>
      <dl className="grid grid-cols-2 gap-3">
        <Stat
          label={`Lessons completed (limit: under ${MAX_COMPLETED_LESSON_SHARE * 100}%)`}
          value={`${progress.lessonsCompleted} of ${progress.lessonsTotal} (${Math.round(share * 100)}%)`}
          warn={share >= MAX_COMPLETED_LESSON_SHARE}
        />
        <Stat
          label={`Watched (limit: under ${MAX_WATCHED_HOURS} h)`}
          value={formatHours(progress.secondsWatched)}
          warn={progress.secondsWatched >= MAX_WATCHED_SECONDS}
        />
        <Stat
          label="Quiz attempts"
          value={`${progress.quizAttempts} (${progress.quizzesPassed} passed)`}
        />
        <Stat
          label="Last activity"
          value={
            progress.lastActivityAt
              ? new Date(progress.lastActivityAt).toLocaleDateString()
              : "None"
          }
        />
      </dl>
    </div>
  );
}

function RefundCard({ item }: { item: RefundReviewItem }) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if ("success" in fetcher.data) toast.success(fetcher.data.success);
    if ("error" in fetcher.data) toast.error(fetcher.data.error);
  }, [fetcher.state, fetcher.data]);

  const { purchase, sinceRequest, previousRefunds } = item;
  const previousTotal =
    previousRefunds.approved + previousRefunds.declined + previousRefunds.requested;
  const active =
    sinceRequest.lessonsCompleted +
      sinceRequest.secondsWatched +
      sinceRequest.quizAttempts >
    0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">
              <Link to={`/courses/${item.course.slug}`} className="hover:underline">
                {item.course.title}
              </Link>
            </h2>
            <p className="text-sm text-muted-foreground">
              {item.learner.name} ({item.learner.email}) · instructor{" "}
              {item.course.instructorName}
            </p>
          </div>
          <div className="text-right">
            <p className="text-lg font-semibold">
              {formatPrice(purchase.amountPaid)}
            </p>
            <p className="text-xs text-muted-foreground">
              {purchase.paidDiscountedPrice
                ? `Paid in ${purchase.country}, list price ${formatPrice(purchase.listPrice)}`
                : "Paid at list price"}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-xs text-muted-foreground">
            Requested {new Date(item.requestedAt).toLocaleDateString()} ·
            purchased {new Date(purchase.createdAt).toLocaleDateString()} ·{" "}
            {item.daysLeftWhenRequested} day(s) were left in the refund window
            when they asked
          </p>
          <p className="mt-1 text-sm">&ldquo;{item.reason}&rdquo;</p>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <ProgressBlock title="At the time of the request" progress={item.atRequest} />
          <div className="space-y-3">
            <div className="rounded-md border p-3">
              <h4 className="mb-2 text-sm font-semibold">Since the request</h4>
              <dl className="grid grid-cols-3 gap-3">
                <Stat
                  label="Lessons completed"
                  value={String(sinceRequest.lessonsCompleted)}
                  warn={active}
                />
                <Stat
                  label="Watched"
                  value={formatHours(sinceRequest.secondsWatched)}
                  warn={active}
                />
                <Stat
                  label="Quiz attempts"
                  value={String(sinceRequest.quizAttempts)}
                  warn={active}
                />
              </dl>
            </div>
            <div className="rounded-md border p-3">
              <h4 className="mb-2 text-sm font-semibold">
                This learner&apos;s other refunds
              </h4>
              <p className="text-sm">
                {previousTotal === 0
                  ? "None"
                  : `${previousRefunds.approved} approved, ${previousRefunds.declined} declined, ${previousRefunds.requested} open`}
              </p>
            </div>
          </div>
        </div>

        {item.hasClaimedSeat && (
          <p className="flex items-center gap-2 text-sm text-amber-600">
            <AlertTriangle className="size-4" />
            A team seat from this purchase has been claimed. It cannot be
            approved.
          </p>
        )}

        <fetcher.Form method="post" className="space-y-3">
          <input type="hidden" name="refundId" value={item.refundId} />
          <Textarea
            name="note"
            placeholder="Optional note to the learner, included if you decline"
            maxLength={1000}
            rows={2}
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              name="intent"
              value="approve"
              disabled={busy || item.hasClaimedSeat}
              onClick={(event) => {
                if (
                  !window.confirm(
                    `Approve ${formatPrice(purchase.amountPaid)} refund for ${item.learner.name}? They will lose access to the course and all of their progress. This cannot be undone.`
                  )
                ) {
                  event.preventDefault();
                }
              }}
            >
              Approve refund
            </Button>
            <Button
              type="submit"
              name="intent"
              value="decline"
              variant="outline"
              disabled={busy}
            >
              Decline
            </Button>
          </div>
        </fetcher.Form>
      </CardContent>
    </Card>
  );
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { items } = loaderData;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <ReceiptText className="size-6" />
        <div>
          <h1 className="text-2xl font-bold">Refund requests</h1>
          <p className="text-sm text-muted-foreground">
            Oldest first. Approving removes the learner&apos;s access and
            progress.
          </p>
        </div>
      </div>

      {items.length === 0 ? (
        <p className="text-muted-foreground">No refund requests are waiting.</p>
      ) : (
        items.map((item) => <RefundCard key={item.refundId} item={item} />)
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message = isRouteErrorResponse(error)
    ? String(error.data)
    : "Something went wrong.";

  return (
    <div className="mx-auto max-w-xl p-6">
      <h1 className="text-xl font-semibold">Refund requests</h1>
      <p className="mt-2 text-muted-foreground">{message}</p>
    </div>
  );
}
