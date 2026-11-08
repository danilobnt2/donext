CREATE TABLE `work_items` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "work_items_type" CHECK("work_items"."type" IN ('todo', 'task'))
);
