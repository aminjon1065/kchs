CREATE TABLE "recordings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"meeting_id" uuid NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"egress_id" text,
	"storage_key" text NOT NULL,
	"file_id" uuid,
	"duration_s" integer,
	"size_bytes" bigint,
	"transcript_status" text DEFAULT 'off' NOT NULL,
	"error" text,
	"started_by" uuid,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recordings_egress_id_unique" UNIQUE("egress_id")
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recording_id" uuid NOT NULL,
	"language" text,
	"model" text,
	"duration_s" integer,
	"segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcripts_recording_id_unique" UNIQUE("recording_id")
);
--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recordings_meeting_idx" ON "recordings" USING btree ("meeting_id","created_at");--> statement-breakpoint
CREATE INDEX "recordings_status_idx" ON "recordings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "transcripts_recording_idx" ON "transcripts" USING btree ("recording_id");