CREATE TABLE `todo_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`todo_id` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`change` text NOT NULL,
	`changed_fields` text NOT NULL,
	`changed_at` integer NOT NULL,
	`device_changed_at` integer,
	`actor` text NOT NULL,
	`title` text NOT NULL,
	`notes` text NOT NULL,
	`due_date` text,
	`state` text NOT NULL,
	CONSTRAINT "todo_versions_version" CHECK("todo_versions"."version" >= 1),
	CONSTRAINT "todo_versions_change" CHECK("todo_versions"."change" IN ('create', 'edit')),
	CONSTRAINT "todo_versions_actor" CHECK(json_extract("todo_versions"."actor", '$.kind') IN ('device', 'system', 'connector')),
	CONSTRAINT "todo_versions_title" CHECK("todo_versions"."title" <> ''),
	CONSTRAINT "todo_versions_due_date" CHECK("todo_versions"."due_date" IS NULL OR date("todo_versions"."due_date") IS "todo_versions"."due_date"),
	CONSTRAINT "todo_versions_state" CHECK("todo_versions"."state" IN ('new', 'active', 'pending', 'done', 'abandoned'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `todo_versions_todo_version` ON `todo_versions` (`todo_id`,`version`);--> statement-breakpoint
DROP TABLE `work_items`;