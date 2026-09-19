CREATE TABLE "calendar_feeds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"calendar_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "calendars" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"owner_id" uuid,
	"color" text DEFAULT 'blue' NOT NULL,
	"timezone" text DEFAULT 'Asia/Dushanbe' NOT NULL,
	"description" text,
	"system_key" text,
	"project_id" uuid,
	"resource" jsonb,
	"source_enc" "bytea",
	"source_host" text,
	"sync_status" text,
	"synced_at" timestamp with time zone,
	"sync_error" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_attendees" (
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'attendee' NOT NULL,
	"optional" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'needs_action' NOT NULL,
	"comment" text,
	"proposal" jsonb,
	"responded_at" timestamp with time zone,
	"reminders" jsonb,
	CONSTRAINT "event_attendees_event_id_user_id_pk" PRIMARY KEY("event_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "event_instances" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "event_instances_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"recurrence_id" timestamp with time zone NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"start_date" date,
	"end_date" date,
	"overridden" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_reminders" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "event_reminders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"recurrence_id" timestamp with time zone NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"minutes" integer NOT NULL,
	"channels" text[] NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_resources" (
	"event_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	CONSTRAINT "event_resources_event_id_resource_id_pk" PRIMARY KEY("event_id","resource_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"calendar_id" uuid NOT NULL,
	"organizer_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"start_date" date,
	"end_date" date,
	"timezone" text NOT NULL,
	"rrule" text,
	"exdates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"materialized_until" timestamp with time zone,
	"location" text,
	"description" text,
	"meeting_id" uuid,
	"visibility" text DEFAULT 'public' NOT NULL,
	"transparency" text DEFAULT 'opaque' NOT NULL,
	"reminders" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"linked_object_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"color" text,
	"uid" text NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'local' NOT NULL,
	"series_id" uuid
);
--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_instances" ADD CONSTRAINT "event_instances_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_reminders" ADD CONSTRAINT "event_reminders_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_reminders" ADD CONSTRAINT "event_reminders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_resources" ADD CONSTRAINT "event_resources_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_resources" ADD CONSTRAINT "event_resources_resource_id_calendars_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_organizer_id_users_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_feeds_token_uq" ON "calendar_feeds" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "calendar_feeds_calendar_idx" ON "calendar_feeds" USING btree ("calendar_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendars_system_key_uq" ON "calendars" USING btree ("system_key");--> statement-breakpoint
CREATE INDEX "calendars_owner_idx" ON "calendars" USING btree ("owner_id","kind");--> statement-breakpoint
CREATE INDEX "calendars_kind_idx" ON "calendars" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "event_attendees_user_idx" ON "event_attendees" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "event_instances_event_recurrence_uq" ON "event_instances" USING btree ("event_id","recurrence_id");--> statement-breakpoint
CREATE INDEX "event_instances_event_idx" ON "event_instances" USING btree ("event_id","starts_at");--> statement-breakpoint
CREATE INDEX "event_instances_calendar_idx" ON "event_instances" USING btree ("calendar_id","starts_at");--> statement-breakpoint
CREATE INDEX "event_instances_period_idx" ON "event_instances" USING gist (tstzrange("starts_at", "ends_at", '[)'));--> statement-breakpoint
CREATE UNIQUE INDEX "event_reminders_uq" ON "event_reminders" USING btree ("event_id","user_id","recurrence_id","starts_at","minutes");--> statement-breakpoint
CREATE INDEX "event_reminders_due_idx" ON "event_reminders" USING btree ("fire_at") WHERE "event_reminders"."sent_at" is null;--> statement-breakpoint
CREATE INDEX "event_resources_resource_idx" ON "event_resources" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "events_calendar_idx" ON "events" USING btree ("calendar_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_calendar_uid_uq" ON "events" USING btree ("calendar_id","uid");--> statement-breakpoint
CREATE INDEX "events_rrule_idx" ON "events" USING btree ("materialized_until") WHERE "events"."rrule" is not null;