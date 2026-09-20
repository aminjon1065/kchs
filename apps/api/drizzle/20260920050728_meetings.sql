CREATE TABLE "meeting_participants" (
	"meeting_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'participant' NOT NULL,
	"joined_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	CONSTRAINT "meeting_participants_meeting_id_user_id_pk" PRIMARY KEY("meeting_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"room_name" text NOT NULL,
	"event_id" uuid,
	"conversation_id" uuid,
	"organizer_id" uuid,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meetings_room_name_unique" UNIQUE("room_name")
);
--> statement-breakpoint
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_organizer_id_users_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_participants_user_idx" ON "meeting_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "meetings_status_idx" ON "meetings" USING btree ("status","starts_at");--> statement-breakpoint
CREATE INDEX "meetings_event_idx" ON "meetings" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "meetings_conversation_idx" ON "meetings" USING btree ("conversation_id");