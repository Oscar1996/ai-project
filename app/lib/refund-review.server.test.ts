import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { LessonProgressStatus, RefundStatus, UserRole } from "~/db/schema";
import {
  approveRefund,
  declineRefund,
  listRefundsForReview,
  measureProgress,
} from "./refund-review.server";

const REQUESTED_AT = "2026-01-10T12:00:00.000Z";
const BEFORE = "2026-01-09T12:00:00.000Z";
const AFTER = "2026-01-11T12:00:00.000Z";

function setup() {
  const db = createTestDb();
  const base = seedBaseData(db);

  const admin = db
    .insert(schema.users)
    .values({ name: "Pat Admin", email: "admin@example.com", role: UserRole.Admin })
    .returning()
    .get();

  const mod = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module", position: 1 })
    .returning()
    .get();

  const lessonRows = [1, 2, 3, 4].map((position) =>
    db
      .insert(schema.lessons)
      .values({ moduleId: mod.id, title: `Lesson ${position}`, position })
      .returning()
      .get()
  );

  db.insert(schema.enrollments)
    .values({ userId: base.user.id, courseId: base.course.id })
    .run();

  const purchase = db
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: 300,
      country: "AR",
      createdAt: "2026-01-05T12:00:00.000Z",
    })
    .returning()
    .get();

  const refund = db
    .insert(schema.refunds)
    .values({
      purchaseId: purchase.id,
      reason: "Not what I expected",
      requestedAt: REQUESTED_AT,
    })
    .returning()
    .get();

  return { db, admin, mod, lessons: lessonRows, purchase, refund, ...base };
}

type Ctx = ReturnType<typeof setup>;

function complete(ctx: Ctx, lessonId: number, at: string) {
  ctx.db
    .insert(schema.lessonProgress)
    .values({
      userId: ctx.user.id,
      lessonId,
      status: LessonProgressStatus.Completed,
      completedAt: at,
    })
    .run();
}

function watch(ctx: Ctx, lessonId: number, position: number, at: string) {
  ctx.db
    .insert(schema.videoWatchEvents)
    .values({
      userId: ctx.user.id,
      lessonId,
      eventType: "progress",
      positionSeconds: position,
      createdAt: at,
    })
    .run();
}

describe("measureProgress", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it("counts completed lessons and the furthest point watched per lesson", () => {
    complete(ctx, ctx.lessons[0].id, BEFORE);
    watch(ctx, ctx.lessons[0].id, 100, BEFORE);
    watch(ctx, ctx.lessons[0].id, 600, BEFORE);
    watch(ctx, ctx.lessons[1].id, 300, BEFORE);

    const progress = measureProgress(ctx.db, ctx.user.id, ctx.course.id);

    expect(progress.lessonsCompleted).toBe(1);
    expect(progress.lessonsTotal).toBe(4);
    expect(progress.secondsWatched).toBe(900);
  });

  it("with asOf, ignores anything after that moment", () => {
    complete(ctx, ctx.lessons[0].id, BEFORE);
    complete(ctx, ctx.lessons[1].id, AFTER);
    watch(ctx, ctx.lessons[0].id, 100, BEFORE);
    watch(ctx, ctx.lessons[0].id, 500, AFTER);

    const progress = measureProgress(
      ctx.db,
      ctx.user.id,
      ctx.course.id,
      REQUESTED_AT
    );

    expect(progress.lessonsCompleted).toBe(1);
    expect(progress.secondsWatched).toBe(100);
  });
});

describe("listRefundsForReview", () => {
  it("shows requested refunds with progress at request and since", () => {
    const ctx = setup();
    complete(ctx, ctx.lessons[0].id, BEFORE);
    watch(ctx, ctx.lessons[0].id, 200, BEFORE);
    complete(ctx, ctx.lessons[1].id, AFTER);
    watch(ctx, ctx.lessons[1].id, 400, AFTER);

    const [item] = listRefundsForReview(ctx.db);

    expect(item.learner.name).toBe("Test User");
    expect(item.course.instructorName).toBe("Test Instructor");
    expect(item.purchase.amountPaid).toBe(300);
    expect(item.purchase.paidDiscountedPrice).toBe(true);
    expect(item.atRequest.lessonsCompleted).toBe(1);
    expect(item.current.lessonsCompleted).toBe(2);
    expect(item.sinceRequest).toEqual({
      lessonsCompleted: 1,
      secondsWatched: 400,
      quizAttempts: 0,
    });
    // Bought 5 Jan, asked 10 Jan: the window ran to 19 Jan.
    expect(item.daysLeftWhenRequested).toBe(9);
  });

  it("leaves out refunds that are already decided", () => {
    const ctx = setup();
    declineRefund(ctx.db, ctx.refund.id, ctx.admin.id, null);

    expect(listRefundsForReview(ctx.db)).toHaveLength(0);
  });

  it("counts the learner's other refunds", () => {
    const ctx = setup();
    const other = ctx.db
      .insert(schema.purchases)
      .values({ userId: ctx.user.id, courseId: ctx.course.id, amountPaid: 100 })
      .returning()
      .get();
    ctx.db
      .insert(schema.refunds)
      .values({
        purchaseId: other.id,
        reason: "Earlier request",
        status: RefundStatus.Declined,
      })
      .run();

    const [item] = listRefundsForReview(ctx.db);

    expect(item.previousRefunds).toEqual({ approved: 0, declined: 1, requested: 0 });
  });

  it("flags a purchase whose seat has been claimed", () => {
    const ctx = setup();
    const { team, coupon } = addTeamSeat(ctx, true);
    expect(team).toBeDefined();
    expect(coupon).toBeDefined();

    const [item] = listRefundsForReview(ctx.db);
    expect(item.hasClaimedSeat).toBe(true);
  });
});

describe("approveRefund", () => {
  it("records the amount paid, not the list price", () => {
    const ctx = setup();
    ctx.db
      .update(schema.courses)
      .set({ price: 1000 })
      .where(eq(schema.courses.id, ctx.course.id))
      .run();

    const result = approveRefund(ctx.db, ctx.refund.id, ctx.admin.id);

    expect(result.ok).toBe(true);
    const refund = getRefund(ctx);
    expect(refund.status).toBe(RefundStatus.Approved);
    expect(refund.amountRefunded).toBe(300);
    expect(refund.resolvedByUserId).toBe(ctx.admin.id);
    expect(refund.resolvedAt).not.toBeNull();
  });

  it("removes access and deletes the learner's course progress", () => {
    const ctx = setup();
    complete(ctx, ctx.lessons[0].id, BEFORE);
    watch(ctx, ctx.lessons[0].id, 100, BEFORE);
    addQuizAttempt(ctx, AFTER);
    ctx.db
      .insert(schema.courseRatings)
      .values({ userId: ctx.user.id, courseId: ctx.course.id, rating: 4 })
      .run();

    approveRefund(ctx.db, ctx.refund.id, ctx.admin.id);

    expect(ctx.db.select().from(schema.enrollments).all()).toHaveLength(0);
    expect(ctx.db.select().from(schema.lessonProgress).all()).toHaveLength(0);
    expect(ctx.db.select().from(schema.videoWatchEvents).all()).toHaveLength(0);
    expect(ctx.db.select().from(schema.quizAttempts).all()).toHaveLength(0);
    expect(ctx.db.select().from(schema.quizAnswers).all()).toHaveLength(0);
    expect(ctx.db.select().from(schema.courseRatings).all()).toHaveLength(0);
  });

  it("keeps the learner's comments", () => {
    const ctx = setup();
    ctx.db
      .insert(schema.comments)
      .values({ lessonId: ctx.lessons[0].id, userId: ctx.user.id, body: "Hello" })
      .run();

    approveRefund(ctx.db, ctx.refund.id, ctx.admin.id);

    expect(ctx.db.select().from(schema.comments).all()).toHaveLength(1);
  });

  it("leaves other learners' progress alone", () => {
    const ctx = setup();
    const other = ctx.db
      .insert(schema.users)
      .values({ name: "Other", email: "other@example.com", role: UserRole.Student })
      .returning()
      .get();
    ctx.db
      .insert(schema.enrollments)
      .values({ userId: other.id, courseId: ctx.course.id })
      .run();
    ctx.db
      .insert(schema.lessonProgress)
      .values({
        userId: other.id,
        lessonId: ctx.lessons[0].id,
        status: LessonProgressStatus.Completed,
      })
      .run();

    approveRefund(ctx.db, ctx.refund.id, ctx.admin.id);

    expect(ctx.db.select().from(schema.enrollments).all()).toHaveLength(1);
    expect(ctx.db.select().from(schema.lessonProgress).all()).toHaveLength(1);
  });

  it("freezes the progress summary onto the refund before deleting it", () => {
    const ctx = setup();
    complete(ctx, ctx.lessons[0].id, BEFORE);
    watch(ctx, ctx.lessons[0].id, 120, BEFORE);
    complete(ctx, ctx.lessons[1].id, AFTER);
    watch(ctx, ctx.lessons[1].id, 60, AFTER);
    addQuizAttempt(ctx, AFTER);

    approveRefund(ctx.db, ctx.refund.id, ctx.admin.id);

    const refund = getRefund(ctx);
    expect(refund.progressLessonsCompleted).toBe(1);
    expect(refund.progressLessonsTotal).toBe(4);
    expect(refund.progressSecondsWatched).toBe(120);
    expect(refund.progressLessonsCompletedSinceRequest).toBe(1);
    expect(refund.progressSecondsWatchedSinceRequest).toBe(60);
    expect(refund.progressQuizAttemptsSinceRequest).toBe(1);
  });

  it("may approve a learner who has since gone past the eligibility limits", () => {
    const ctx = setup();
    ctx.lessons.forEach((lesson) => complete(ctx, lesson.id, AFTER));

    expect(approveRefund(ctx.db, ctx.refund.id, ctx.admin.id).ok).toBe(true);
  });

  it("voids unclaimed team seats and leaves the buyer's own enrollment", () => {
    const ctx = setup();
    addTeamSeat(ctx, false);

    const result = approveRefund(ctx.db, ctx.refund.id, ctx.admin.id);

    expect(result.ok).toBe(true);
    expect(ctx.db.select().from(schema.coupons).all()).toHaveLength(0);
    expect(ctx.db.select().from(schema.enrollments).all()).toHaveLength(1);
  });

  it("refuses when a seat has been claimed, changing nothing", () => {
    const ctx = setup();
    addTeamSeat(ctx, true);

    const result = approveRefund(ctx.db, ctx.refund.id, ctx.admin.id);

    expect(result).toEqual({ ok: false, reason: "seat-claimed" });
    expect(getRefund(ctx).status).toBe(RefundStatus.Requested);
    expect(ctx.db.select().from(schema.coupons).all()).toHaveLength(1);
  });

  it("refuses a refund that is already decided", () => {
    const ctx = setup();
    approveRefund(ctx.db, ctx.refund.id, ctx.admin.id);

    expect(approveRefund(ctx.db, ctx.refund.id, ctx.admin.id)).toEqual({
      ok: false,
      reason: "not-requested",
    });
  });

  it("reports a refund that does not exist", () => {
    const ctx = setup();

    expect(approveRefund(ctx.db, 9999, ctx.admin.id)).toEqual({
      ok: false,
      reason: "not-found",
    });
  });
});

describe("declineRefund", () => {
  it("keeps access and progress, refunds nothing, and stores the note", () => {
    const ctx = setup();
    complete(ctx, ctx.lessons[0].id, BEFORE);

    const result = declineRefund(
      ctx.db,
      ctx.refund.id,
      ctx.admin.id,
      "Too much watched"
    );

    expect(result.ok).toBe(true);
    const refund = getRefund(ctx);
    expect(refund.status).toBe(RefundStatus.Declined);
    expect(refund.amountRefunded).toBeNull();
    expect(refund.declineNote).toBe("Too much watched");
    expect(refund.resolvedByUserId).toBe(ctx.admin.id);
    expect(ctx.db.select().from(schema.enrollments).all()).toHaveLength(1);
    expect(ctx.db.select().from(schema.lessonProgress).all()).toHaveLength(1);
  });

  it("accepts no note", () => {
    const ctx = setup();
    declineRefund(ctx.db, ctx.refund.id, ctx.admin.id, null);

    expect(getRefund(ctx).declineNote).toBeNull();
  });

  it("refuses a refund that is already decided", () => {
    const ctx = setup();
    declineRefund(ctx.db, ctx.refund.id, ctx.admin.id, null);

    expect(declineRefund(ctx.db, ctx.refund.id, ctx.admin.id, null)).toEqual({
      ok: false,
      reason: "not-requested",
    });
  });
});

// ─── helpers ───

function getRefund(ctx: Ctx) {
  return ctx.db
    .select()
    .from(schema.refunds)
    .where(eq(schema.refunds.id, ctx.refund.id))
    .get()!;
}

function addTeamSeat(ctx: Ctx, claimed: boolean) {
  const team = ctx.db.insert(schema.teams).values({}).returning().get();
  const coupon = ctx.db
    .insert(schema.coupons)
    .values({
      teamId: team.id,
      courseId: ctx.course.id,
      code: `code-${claimed ? "claimed" : "open"}`,
      purchaseId: ctx.purchase.id,
      redeemedByUserId: claimed ? ctx.instructor.id : null,
      redeemedAt: claimed ? BEFORE : null,
    })
    .returning()
    .get();
  return { team, coupon };
}

function addQuizAttempt(ctx: Ctx, at: string) {
  const quiz = ctx.db
    .insert(schema.quizzes)
    .values({ lessonId: ctx.lessons[0].id, title: "Quiz", passingScore: 0.5 })
    .returning()
    .get();
  const question = ctx.db
    .insert(schema.quizQuestions)
    .values({
      quizId: quiz.id,
      questionText: "?",
      questionType: schema.QuestionType.TrueFalse,
      position: 1,
    })
    .returning()
    .get();
  const option = ctx.db
    .insert(schema.quizOptions)
    .values({ questionId: question.id, optionText: "True", isCorrect: true })
    .returning()
    .get();
  const attempt = ctx.db
    .insert(schema.quizAttempts)
    .values({
      userId: ctx.user.id,
      quizId: quiz.id,
      score: 1,
      passed: true,
      attemptedAt: at,
    })
    .returning()
    .get();
  ctx.db
    .insert(schema.quizAnswers)
    .values({
      attemptId: attempt.id,
      questionId: question.id,
      selectedOptionId: option.id,
    })
    .run();
}
