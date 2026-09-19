ALTER TABLE "process_steps" ALTER COLUMN "status" SET DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "process_definitions" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "process_definitions" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "process_instances" ADD COLUMN "definition_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "process_instances" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "process_steps" ADD COLUMN "resolved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "process_steps" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "process_steps" ADD COLUMN "round" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "process_steps" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "process_steps" ADD COLUMN "branch" integer;--> statement-breakpoint
ALTER TABLE "process_steps" ADD COLUMN "prev_id" uuid;--> statement-breakpoint
ALTER TABLE "process_steps" ADD COLUMN "timers" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "process_steps" ADD COLUMN "next_timer_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "process_steps" ADD COLUMN "wait_event" text;--> statement-breakpoint
ALTER TABLE "process_steps" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "process_definitions_draft_key" ON "process_definitions" USING btree ("key") WHERE "process_definitions"."published_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "process_instances_running_key" ON "process_instances" USING btree ("object_id","definition_key") WHERE "process_instances"."status" = 'running';--> statement-breakpoint
CREATE INDEX "process_steps_timer_idx" ON "process_steps" USING btree ("next_timer_at") WHERE "process_steps"."status" = 'active' and "process_steps"."next_timer_at" is not null;--> statement-breakpoint
CREATE INDEX "process_steps_wait_idx" ON "process_steps" USING btree ("wait_event") WHERE "process_steps"."status" = 'active' and "process_steps"."wait_event" is not null;--> statement-breakpoint
CREATE INDEX "process_steps_assignees_idx" ON "process_steps" USING gin ("assignees" jsonb_path_ops);