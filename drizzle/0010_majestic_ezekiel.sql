ALTER TABLE `refunds` ADD `decline_note` text;--> statement-breakpoint
ALTER TABLE `refunds` ADD `progress_lessons_completed` integer;--> statement-breakpoint
ALTER TABLE `refunds` ADD `progress_lessons_total` integer;--> statement-breakpoint
ALTER TABLE `refunds` ADD `progress_seconds_watched` integer;--> statement-breakpoint
ALTER TABLE `refunds` ADD `progress_lessons_completed_since_request` integer;--> statement-breakpoint
ALTER TABLE `refunds` ADD `progress_seconds_watched_since_request` integer;--> statement-breakpoint
ALTER TABLE `refunds` ADD `progress_quiz_attempts_since_request` integer;