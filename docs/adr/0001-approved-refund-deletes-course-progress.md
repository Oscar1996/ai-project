# Approving a refund deletes the learner's course progress

When a platform admin approves a refund, the learner's enrollment and all of their course progress (lesson progress, video watch events, quiz attempts and answers, and course rating) are deleted in the same transaction. A learner who buys the course again starts from scratch. We chose this over keeping progress so a refund is a clean reversal of the purchase: a learner cannot get their money back and keep what they earned.

The detailed progress rows are the only thing deleted. A summary of the progress the platform admin approved against (lessons completed out of total, hours watched, and activity since the request) is frozen onto the refund record, so refund history stays auditable. Comments are kept, because other learners' replies depend on them.

## Considered Options

- **Keep progress, remove only the enrollment.** Preserves the audit evidence and lets a returning learner resume, but they would keep the value of a course they were refunded for. Rejected in favour of the frozen summary.

## Consequences

- Deletion is irreversible. A mistaken approval cannot restore the learner's progress.
- The refund record is the only surviving evidence of what the learner had done.
