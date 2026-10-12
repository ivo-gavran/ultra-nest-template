CREATE TABLE "example_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" varchar(80) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "example_records_label_unique" UNIQUE("label"),
	CONSTRAINT "example_records_label_not_blank" CHECK (length(trim("example_records"."label")) > 0)
);
