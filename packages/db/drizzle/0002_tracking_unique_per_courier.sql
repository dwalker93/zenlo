DROP INDEX "shipments_tracking_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_courier_tracking_uq" ON "shipments" USING btree ("courier","tracking_number");