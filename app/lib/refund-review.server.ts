// ─── Refund Review ───
// What a platform admin sees and does when reviewing a Requested refund.
//
// Every function takes the database as its first argument (project convention
// is positional parameters), so tests can hand in an in-memory one.

import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  sql,
} from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import {
  coupons,
  courseRatings,
  courses,
  enrollments,
  lessonProgress,
  lessons,
  modules,
  purchases,
  quizAnswers,
  quizAttempts,
  quizzes,
  refunds,
  users,
  videoWatchEvents,
  LessonProgressStatus,
  RefundStatus,
} from "~/db/schema";
import { getDiscountForCountry } from "~/lib/ppp";
import { formatPrice } from "~/lib/utils";
import { refundWindowDaysLeft } from "~/lib/refund-policy";

type Db = BetterSQLite3Database<typeof schema>;
// What a transaction and the database have in common.
type Queryable = Pick<Db, "select" | "insert" | "update" | "delete">;

// ─── Course progress ───

export type CourseProgress = {
  lessonsCompleted: number;
  lessonsTotal: number;
  secondsWatched: number;
  quizAttempts: number;
  quizzesPassed: number;
  lastActivityAt: string | null;
};

export function getLessonIdsForCourse(
  database: Queryable,
  courseId: number
): number[] {
  return database
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

/**
 * What a learner has done in a course. With `asOf`, only what existed at that
 * moment is counted — used for "at the time of the request".
 */
export function measureProgress(
  database: Queryable,
  userId: number,
  courseId: number,
  asOf?: string
): CourseProgress {
  const lessonIds = getLessonIdsForCourse(database, courseId);

  if (lessonIds.length === 0) {
    return {
      lessonsCompleted: 0,
      lessonsTotal: 0,
      secondsWatched: 0,
      quizAttempts: 0,
      quizzesPassed: 0,
      lastActivityAt: null,
    };
  }

  const completedRows = database
    .select({ completedAt: lessonProgress.completedAt })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .all()
    .filter((row) => !asOf || !row.completedAt || row.completedAt <= asOf);

  // Watch time is the furthest point reached in each lesson, summed — so
  // re-watching the same minutes doesn't count twice.
  const furthestPerLesson = database
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
      lastEvent: sql<string>`max(${videoWatchEvents.createdAt})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds),
        asOf ? lte(videoWatchEvents.createdAt, asOf) : undefined
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  const attemptRows = database
    .select({
      passed: quizAttempts.passed,
      attemptedAt: quizAttempts.attemptedAt,
    })
    .from(quizAttempts)
    .innerJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
    .where(
      and(
        eq(quizAttempts.userId, userId),
        inArray(quizzes.lessonId, lessonIds),
        asOf ? lte(quizAttempts.attemptedAt, asOf) : undefined
      )
    )
    .all();

  const activity = [
    ...completedRows.map((row) => row.completedAt),
    ...furthestPerLesson.map((row) => row.lastEvent),
    ...attemptRows.map((row) => row.attemptedAt),
  ].filter((value): value is string => !!value);

  return {
    lessonsCompleted: completedRows.length,
    lessonsTotal: lessonIds.length,
    secondsWatched: Math.round(
      furthestPerLesson.reduce((total, row) => total + row.furthest, 0)
    ),
    quizAttempts: attemptRows.length,
    quizzesPassed: attemptRows.filter((row) => row.passed).length,
    lastActivityAt: activity.length > 0 ? activity.sort().at(-1)! : null,
  };
}

export type ProgressSinceRequest = {
  lessonsCompleted: number;
  secondsWatched: number;
  quizAttempts: number;
};

export function progressSince(
  atRequest: CourseProgress,
  now: CourseProgress
): ProgressSinceRequest {
  return {
    lessonsCompleted: Math.max(0, now.lessonsCompleted - atRequest.lessonsCompleted),
    secondsWatched: Math.max(0, now.secondsWatched - atRequest.secondsWatched),
    quizAttempts: Math.max(0, now.quizAttempts - atRequest.quizAttempts),
  };
}

// ─── The review queue ───

export type RefundReviewItem = {
  refundId: number;
  reason: string;
  requestedAt: string;
  learner: { id: number; name: string; email: string };
  course: { id: number; title: string; slug: string; instructorName: string };
  purchase: {
    id: number;
    createdAt: string;
    amountPaid: number;
    listPrice: number;
    country: string | null;
    paidDiscountedPrice: boolean;
  };
  /** Days that were left in the refund window on the day the learner asked. */
  daysLeftWhenRequested: number;
  atRequest: CourseProgress;
  current: CourseProgress;
  sinceRequest: ProgressSinceRequest;
  previousRefunds: { approved: number; declined: number; requested: number };
  /** Some seat from this purchase has been claimed, so approval is blocked. */
  hasClaimedSeat: boolean;
};

function hasClaimedSeat(database: Queryable, purchaseId: number): boolean {
  return !!database
    .select({ id: coupons.id })
    .from(coupons)
    .where(and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt)))
    .get();
}

function countPreviousRefunds(
  database: Queryable,
  userId: number,
  excludingRefundId: number
) {
  const rows = database
    .select({ status: refunds.status })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .where(and(eq(purchases.userId, userId), ne(refunds.id, excludingRefundId)))
    .all();

  return {
    approved: rows.filter((r) => r.status === RefundStatus.Approved).length,
    declined: rows.filter((r) => r.status === RefundStatus.Declined).length,
    requested: rows.filter((r) => r.status === RefundStatus.Requested).length,
  };
}

/** Requested refunds, oldest request first. */
export function listRefundsForReview(database: Db): RefundReviewItem[] {
  const rows = database
    .select({
      refundId: refunds.id,
      reason: refunds.reason,
      requestedAt: refunds.requestedAt,
      purchaseId: purchases.id,
      purchasedAt: purchases.createdAt,
      amountPaid: purchases.amountPaid,
      country: purchases.country,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      listPrice: courses.price,
      instructorId: courses.instructorId,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.status, RefundStatus.Requested))
    .orderBy(refunds.requestedAt)
    .all();

  return rows.map((row) => {
    const instructor = database
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, row.instructorId))
      .get();

    const atRequest = measureProgress(
      database,
      row.learnerId,
      row.courseId,
      row.requestedAt
    );
    const current = measureProgress(database, row.learnerId, row.courseId);

    return {
      refundId: row.refundId,
      reason: row.reason,
      requestedAt: row.requestedAt,
      learner: { id: row.learnerId, name: row.learnerName, email: row.learnerEmail },
      course: {
        id: row.courseId,
        title: row.courseTitle,
        slug: row.courseSlug,
        instructorName: instructor?.name ?? "Unknown",
      },
      purchase: {
        id: row.purchaseId,
        createdAt: row.purchasedAt,
        amountPaid: row.amountPaid,
        listPrice: row.listPrice,
        country: row.country,
        paidDiscountedPrice: getDiscountForCountry(row.country) > 0,
      },
      daysLeftWhenRequested: refundWindowDaysLeft(
        row.purchasedAt,
        new Date(row.requestedAt)
      ),
      atRequest,
      current,
      sinceRequest: progressSince(atRequest, current),
      previousRefunds: countPreviousRefunds(database, row.learnerId, row.refundId),
      hasClaimedSeat: hasClaimedSeat(database, row.purchaseId),
    };
  });
}

// ─── Deciding ───

export type ReviewFailure = "not-found" | "not-requested" | "seat-claimed";

export type ReviewResult =
  | {
      ok: true;
      learnerName: string;
      learnerEmail: string;
      courseTitle: string;
      amount: number;
      note: string | null;
    }
  | { ok: false; reason: ReviewFailure };

function loadRequestedRefund(database: Queryable, refundId: number) {
  return database
    .select({
      refund: refunds,
      purchase: purchases,
      learnerName: users.name,
      learnerEmail: users.email,
      courseTitle: courses.title,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.id, refundId))
    .get();
}

/**
 * Approves a Requested refund. In one transaction: records the amount paid as
 * refunded, freezes a summary of the learner's progress onto the refund, voids
 * the purchase's unclaimed team seats, then removes the learner's access and
 * deletes their course progress.
 */
export function approveRefund(
  database: Db,
  refundId: number,
  adminUserId: number,
  now: Date = new Date()
): ReviewResult {
  return database.transaction((tx) => {
    const found = loadRequestedRefund(tx, refundId);
    if (!found) return { ok: false, reason: "not-found" } as const;
    if (found.refund.status !== RefundStatus.Requested) {
      return { ok: false, reason: "not-requested" } as const;
    }

    const { refund, purchase } = found;

    // A claimed seat belongs to the team. Unlike the learner's progress this
    // isn't a judgement call, so approval refuses.
    if (hasClaimedSeat(tx, purchase.id)) {
      return { ok: false, reason: "seat-claimed" } as const;
    }

    const atRequest = measureProgress(
      tx,
      purchase.userId,
      purchase.courseId,
      refund.requestedAt
    );
    const current = measureProgress(tx, purchase.userId, purchase.courseId);
    const since = progressSince(atRequest, current);

    tx.update(refunds)
      .set({
        status: RefundStatus.Approved,
        amountRefunded: purchase.amountPaid,
        resolvedAt: now.toISOString(),
        resolvedByUserId: adminUserId,
        progressLessonsCompleted: atRequest.lessonsCompleted,
        progressLessonsTotal: atRequest.lessonsTotal,
        progressSecondsWatched: atRequest.secondsWatched,
        progressLessonsCompletedSinceRequest: since.lessonsCompleted,
        progressSecondsWatchedSinceRequest: since.secondsWatched,
        progressQuizAttemptsSinceRequest: since.quizAttempts,
      })
      .where(eq(refunds.id, refund.id))
      .run();

    const teamSeats = tx
      .select({ id: coupons.id })
      .from(coupons)
      .where(eq(coupons.purchaseId, purchase.id))
      .all();

    if (teamSeats.length > 0) {
      // A team licence: the buyer isn't enrolled by this purchase, so there is
      // nothing of theirs to take away. The seats nobody has claimed die with
      // the refund.
      tx.delete(coupons)
        .where(and(eq(coupons.purchaseId, purchase.id), isNull(coupons.redeemedAt)))
        .run();
    } else {
      removeLearnerFromCourse(tx, purchase.userId, purchase.courseId);
    }

    return {
      ok: true,
      learnerName: found.learnerName,
      learnerEmail: found.learnerEmail,
      courseTitle: found.courseTitle,
      amount: purchase.amountPaid,
      note: null,
    } as const;
  });
}

/** Declining changes nothing for the learner: access and progress stay. */
export function declineRefund(
  database: Db,
  refundId: number,
  adminUserId: number,
  note: string | null,
  now: Date = new Date()
): ReviewResult {
  return database.transaction((tx) => {
    const found = loadRequestedRefund(tx, refundId);
    if (!found) return { ok: false, reason: "not-found" } as const;
    if (found.refund.status !== RefundStatus.Requested) {
      return { ok: false, reason: "not-requested" } as const;
    }

    tx.update(refunds)
      .set({
        status: RefundStatus.Declined,
        resolvedAt: now.toISOString(),
        resolvedByUserId: adminUserId,
        declineNote: note,
      })
      .where(eq(refunds.id, refundId))
      .run();

    return {
      ok: true,
      learnerName: found.learnerName,
      learnerEmail: found.learnerEmail,
      courseTitle: found.courseTitle,
      amount: found.purchase.amountPaid,
      note,
    } as const;
  });
}

/**
 * Removes the enrollment and everything the learner did in the course.
 * Their comments are left alone: other learners' replies hang off them.
 */
function removeLearnerFromCourse(
  tx: Queryable,
  userId: number,
  courseId: number
) {
  const lessonIds = getLessonIdsForCourse(tx, courseId);

  if (lessonIds.length > 0) {
    tx.delete(lessonProgress)
      .where(
        and(
          eq(lessonProgress.userId, userId),
          inArray(lessonProgress.lessonId, lessonIds)
        )
      )
      .run();

    tx.delete(videoWatchEvents)
      .where(
        and(
          eq(videoWatchEvents.userId, userId),
          inArray(videoWatchEvents.lessonId, lessonIds)
        )
      )
      .run();

    const attemptIds = tx
      .select({ id: quizAttempts.id })
      .from(quizAttempts)
      .innerJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
      .where(
        and(eq(quizAttempts.userId, userId), inArray(quizzes.lessonId, lessonIds))
      )
      .all()
      .map((row) => row.id);

    if (attemptIds.length > 0) {
      tx.delete(quizAnswers).where(inArray(quizAnswers.attemptId, attemptIds)).run();
      tx.delete(quizAttempts).where(inArray(quizAttempts.id, attemptIds)).run();
    }
  }

  tx.delete(courseRatings)
    .where(and(eq(courseRatings.userId, userId), eq(courseRatings.courseId, courseId)))
    .run();

  tx.delete(enrollments)
    .where(and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId)))
    .run();
}

// ─── Emails ───
// There is no mail transport yet; the route logs what it would send.

export function buildRefundDecisionEmail(
  decision: "approved" | "declined",
  result: Extract<ReviewResult, { ok: true }>
) {
  if (decision === "approved") {
    return {
      to: result.learnerEmail,
      subject: `Refund approved — ${result.courseTitle}`,
      body: [
        `Hi ${result.learnerName},`,
        "",
        `Your refund for "${result.courseTitle}" has been approved.`,
        `We are returning ${formatPrice(result.amount)}, the amount you paid.`,
        "",
        "You no longer have access to the course, and your progress in it has been removed.",
        "",
        "— The Cadence team",
      ].join("\n"),
    };
  }

  return {
    to: result.learnerEmail,
    subject: `Refund declined — ${result.courseTitle}`,
    body: [
      `Hi ${result.learnerName},`,
      "",
      `We have reviewed your refund request for "${result.courseTitle}" and we are unable to approve it.`,
      ...(result.note ? ["", `Note from our team: ${result.note}`] : []),
      "",
      "You keep your access to the course and your progress.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}
