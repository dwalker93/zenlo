CREATE TYPE "public"."attribute_data_type" AS ENUM('text', 'number', 'select', 'boolean');--> statement-breakpoint
CREATE TYPE "public"."badge_audience" AS ENUM('customer', 'seller');--> statement-breakpoint
CREATE TYPE "public"."inventory_movement_type" AS ENUM('restock', 'sale', 'adjustment', 'return', 'damaged', 'transfer');--> statement-breakpoint
CREATE TYPE "public"."message_type" AS ENUM('text', 'system');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending_payment', 'processing', 'partially_fulfilled', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('bank_transfer', 'payhere');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'processing', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payout_entry_type" AS ENUM('sale', 'commission', 'refund', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('pending', 'processing', 'paid', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('requested', 'approved', 'processing', 'succeeded', 'failed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."seller_order_status" AS ENUM('pending', 'processing', 'partially_shipped', 'shipped', 'delivered', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."seller_status" AS ENUM('pending', 'approved', 'suspended', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('pending', 'booked', 'in_transit', 'delivered', 'failed', 'returned', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('customer', 'seller', 'admin');--> statement-breakpoint
CREATE TABLE "addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"full_name" varchar(150) NOT NULL,
	"phone" varchar(32) NOT NULL,
	"line1" varchar(255) NOT NULL,
	"line2" varchar(255),
	"city" varchar(100) NOT NULL,
	"district" varchar(80) NOT NULL,
	"postal_code" varchar(16),
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "badges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(100) NOT NULL,
	"audience" "badge_audience" NOT NULL,
	"name" varchar(100) NOT NULL,
	"title" varchar(100),
	"description" text,
	"icon_url" varchar(500),
	"tier" smallint DEFAULT 1 NOT NULL,
	"metric" varchar(100) NOT NULL,
	"threshold" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "badges_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "seller_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"line1" varchar(255) NOT NULL,
	"line2" varchar(255),
	"city" varchar(100) NOT NULL,
	"district" varchar(80) NOT NULL,
	"postal_code" varchar(16),
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"phone" varchar(32),
	"is_active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seller_payout_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"bank_name" varchar(120) NOT NULL,
	"account_name" varchar(150) NOT NULL,
	"account_number_encrypted" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seller_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"shop_name" varchar(150) NOT NULL,
	"slug" varchar(160) NOT NULL,
	"description" text,
	"status" "seller_status" DEFAULT 'pending' NOT NULL,
	"commission_bps" integer,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "seller_profiles_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "seller_profiles_slug_unique" UNIQUE("slug"),
	CONSTRAINT "seller_profiles_commission_bps_range" CHECK ("seller_profiles"."commission_bps" IS NULL OR "seller_profiles"."commission_bps" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role" "user_role" NOT NULL,
	CONSTRAINT "user_roles_user_id_role_pk" PRIMARY KEY("user_id","role")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"phone" varchar(32),
	"name" varchar(150) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"equipped_badge_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "attribute_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"key" varchar(80) NOT NULL,
	"label" varchar(120) NOT NULL,
	"data_type" "attribute_data_type" NOT NULL,
	"unit" varchar(40),
	"options" jsonb,
	"is_filterable" boolean DEFAULT false NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"name" varchar(120) NOT NULL,
	"slug" varchar(140) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "product_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"storage_key" varchar(500) NOT NULL,
	"alt_text" varchar(255),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" varchar(80),
	"name" varchar(150) NOT NULL,
	"price_cents" bigint NOT NULL,
	"compare_at_price_cents" bigint,
	"currency" char(3) DEFAULT 'LKR' NOT NULL,
	"weight_grams" integer,
	"attributes" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "product_variants_sku_unique" UNIQUE("sku"),
	CONSTRAINT "variants_price_non_negative" CHECK ("product_variants"."price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"slug" varchar(220) NOT NULL,
	"description" text,
	"attributes" jsonb,
	"status" "product_status" DEFAULT 'draft' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "inventory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"on_hand_qty" integer DEFAULT 0 NOT NULL,
	"reserved_qty" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_variant_location_uq" UNIQUE("variant_id","location_id"),
	CONSTRAINT "inventory_qty_bounds" CHECK ("inventory"."on_hand_qty" >= 0 AND "inventory"."reserved_qty" >= 0 AND "inventory"."reserved_qty" <= "inventory"."on_hand_qty")
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inventory_id" uuid NOT NULL,
	"movement_type" "inventory_movement_type" NOT NULL,
	"quantity_delta" integer NOT NULL,
	"reference_type" varchar(60),
	"reference_id" uuid,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cart_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cart_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "cart_items_qty_positive" CHECK ("cart_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "carts_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "favorites" (
	"user_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorites_user_id_product_id_pk" PRIMARY KEY("user_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_order_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"product_title" varchar(200) NOT NULL,
	"variant_name" varchar(150) NOT NULL,
	"sku_snapshot" varchar(80),
	"unit_price_cents" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"line_total_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_qty_positive" CHECK ("order_items"."quantity" > 0),
	CONSTRAINT "order_items_price_non_negative" CHECK ("order_items"."unit_price_cents" >= 0),
	CONSTRAINT "order_items_line_total_matches" CHECK ("order_items"."line_total_cents" = "order_items"."unit_price_cents" * "order_items"."quantity")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" varchar(32) NOT NULL,
	"buyer_id" uuid NOT NULL,
	"status" "order_status" DEFAULT 'pending_payment' NOT NULL,
	"ship_full_name" varchar(150) NOT NULL,
	"ship_phone" varchar(32) NOT NULL,
	"ship_line1" varchar(255) NOT NULL,
	"ship_line2" varchar(255),
	"ship_city" varchar(100) NOT NULL,
	"ship_district" varchar(80) NOT NULL,
	"ship_postal_code" varchar(16),
	"ship_latitude" numeric(9, 6),
	"ship_longitude" numeric(9, 6),
	"subtotal_cents" bigint NOT NULL,
	"delivery_fee_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint NOT NULL,
	"refunded_cents" bigint DEFAULT 0 NOT NULL,
	"currency" char(3) DEFAULT 'LKR' NOT NULL,
	"payment_due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "orders_order_number_unique" UNIQUE("order_number"),
	CONSTRAINT "orders_amounts_non_negative" CHECK ("orders"."subtotal_cents" >= 0 AND "orders"."delivery_fee_cents" >= 0),
	CONSTRAINT "orders_total_matches" CHECK ("orders"."total_cents" = "orders"."subtotal_cents" + "orders"."delivery_fee_cents"),
	CONSTRAINT "orders_refunded_range" CHECK ("orders"."refunded_cents" BETWEEN 0 AND "orders"."total_cents")
);
--> statement-breakpoint
CREATE TABLE "seller_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"seller_name_snapshot" varchar(150) NOT NULL,
	"status" "seller_order_status" DEFAULT 'pending' NOT NULL,
	"subtotal_cents" bigint NOT NULL,
	"delivery_fee_cents" bigint DEFAULT 0 NOT NULL,
	"commission_cents" bigint DEFAULT 0 NOT NULL,
	"seller_earning_cents" bigint DEFAULT 0 NOT NULL,
	"refunded_cents" bigint DEFAULT 0 NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "seller_orders_id_order_uq" UNIQUE("id","order_id"),
	CONSTRAINT "seller_orders_id_seller_uq" UNIQUE("id","seller_id"),
	CONSTRAINT "seller_orders_amounts_non_negative" CHECK ("seller_orders"."subtotal_cents" >= 0 AND "seller_orders"."delivery_fee_cents" >= 0),
	CONSTRAINT "seller_orders_commission_range" CHECK ("seller_orders"."commission_cents" BETWEEN 0 AND "seller_orders"."subtotal_cents"),
	CONSTRAINT "seller_orders_earning_matches" CHECK ("seller_orders"."seller_earning_cents" = "seller_orders"."subtotal_cents" - "seller_orders"."commission_cents"),
	CONSTRAINT "seller_orders_refunded_range" CHECK ("seller_orders"."refunded_cents" BETWEEN 0 AND "seller_orders"."subtotal_cents" + "seller_orders"."delivery_fee_cents")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"method" "payment_method" NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" char(3) DEFAULT 'LKR' NOT NULL,
	"provider_reference" varchar(120),
	"idempotency_key" varchar(120),
	"proof_storage_key" varchar(500),
	"gateway_payload" jsonb,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "payments_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "payments_id_order_uq" UNIQUE("id","order_id"),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "shipment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"status" "shipment_status" NOT NULL,
	"description" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_order_id" uuid NOT NULL,
	"pickup_location_id" uuid NOT NULL,
	"courier" varchar(60) DEFAULT 'promptxpress' NOT NULL,
	"tracking_number" varchar(80),
	"status" "shipment_status" DEFAULT 'pending' NOT NULL,
	"fee_cents" bigint DEFAULT 0 NOT NULL,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"delivery_verified_at" timestamp with time zone,
	"verified_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "shipments_fee_non_negative" CHECK ("shipments"."fee_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "refund_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"refund_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"seller_order_id" uuid NOT NULL,
	"item_amount_cents" bigint DEFAULT 0 NOT NULL,
	"delivery_amount_cents" bigint DEFAULT 0 NOT NULL,
	"amount_cents" bigint NOT NULL,
	"commission_returned_cents" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_allocations_id_seller_order_uq" UNIQUE("id","seller_order_id"),
	CONSTRAINT "refund_allocations_parts_non_negative" CHECK ("refund_allocations"."item_amount_cents" >= 0 AND "refund_allocations"."delivery_amount_cents" >= 0),
	CONSTRAINT "refund_allocations_amount_positive" CHECK ("refund_allocations"."amount_cents" > 0),
	CONSTRAINT "refund_allocations_amount_matches" CHECK ("refund_allocations"."amount_cents" = "refund_allocations"."item_amount_cents" + "refund_allocations"."delivery_amount_cents"),
	CONSTRAINT "refund_allocations_commission_returned_range" CHECK ("refund_allocations"."commission_returned_cents" BETWEEN 0 AND "refund_allocations"."item_amount_cents")
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"reason" text,
	"status" "refund_status" DEFAULT 'requested' NOT NULL,
	"provider_reference" varchar(120),
	"processed_by" uuid,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "refunds_id_order_uq" UNIQUE("id","order_id"),
	CONSTRAINT "refunds_amount_positive" CHECK ("refunds"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "payout_items" (
	"payout_id" uuid NOT NULL,
	"ledger_entry_id" uuid NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "payout_items_payout_id_ledger_entry_id_pk" PRIMARY KEY("payout_id","ledger_entry_id")
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"payout_account_id" uuid,
	"amount_cents" bigint NOT NULL,
	"status" "payout_status" DEFAULT 'pending' NOT NULL,
	"bank_reference" varchar(120),
	"failure_reason" text,
	"paid_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_amount_positive" CHECK ("payouts"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "seller_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"seller_order_id" uuid,
	"refund_allocation_id" uuid,
	"type" "payout_entry_type" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_amount_non_zero" CHECK ("seller_ledger_entries"."amount_cents" <> 0),
	CONSTRAINT "ledger_seller_order_required" CHECK ("seller_ledger_entries"."type" NOT IN ('sale', 'commission', 'refund') OR "seller_ledger_entries"."seller_order_id" IS NOT NULL),
	CONSTRAINT "ledger_refund_allocation_link" CHECK (("seller_ledger_entries"."type" = 'refund') = ("seller_ledger_entries"."refund_allocation_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" varchar(80) NOT NULL,
	"entity_type" varchar(60) NOT NULL,
	"entity_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"buyer_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"product_id" uuid,
	"type" "message_type" DEFAULT 'text' NOT NULL,
	"body" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" varchar(60) NOT NULL,
	"payload" jsonb,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"key" varchar(100) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"buyer_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"rating" smallint NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "reviews_order_item_id_unique" UNIQUE("order_item_id"),
	CONSTRAINT "reviews_rating_range" CHECK ("reviews"."rating" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "user_badges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"badge_id" uuid NOT NULL,
	"awarded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"awarded_by" uuid
);
--> statement-breakpoint
CREATE TABLE "user_stats" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"orders_completed" integer DEFAULT 0 NOT NULL,
	"reviews_written" integer DEFAULT 0 NOT NULL,
	"seller_orders_delivered" integer DEFAULT 0 NOT NULL,
	"seller_reviews_received" integer DEFAULT 0 NOT NULL,
	"seller_rating_x100" integer,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_locations" ADD CONSTRAINT "seller_locations_seller_id_seller_profiles_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."seller_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_payout_accounts" ADD CONSTRAINT "seller_payout_accounts_seller_id_seller_profiles_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."seller_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_profiles" ADD CONSTRAINT "seller_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_profiles" ADD CONSTRAINT "seller_profiles_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_equipped_badge_id_badges_id_fk" FOREIGN KEY ("equipped_badge_id") REFERENCES "public"."badges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_seller_id_seller_profiles_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."seller_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_location_id_seller_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."seller_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_inventory_id_inventory_id_fk" FOREIGN KEY ("inventory_id") REFERENCES "public"."inventory"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_seller_order_id_seller_orders_id_fk" FOREIGN KEY ("seller_order_id") REFERENCES "public"."seller_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_inventory_fk" FOREIGN KEY ("variant_id","location_id") REFERENCES "public"."inventory"("variant_id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_orders" ADD CONSTRAINT "seller_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_orders" ADD CONSTRAINT "seller_orders_seller_id_seller_profiles_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."seller_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_seller_order_id_seller_orders_id_fk" FOREIGN KEY ("seller_order_id") REFERENCES "public"."seller_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_pickup_location_id_seller_locations_id_fk" FOREIGN KEY ("pickup_location_id") REFERENCES "public"."seller_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_allocations" ADD CONSTRAINT "refund_allocations_refund_order_fk" FOREIGN KEY ("refund_id","order_id") REFERENCES "public"."refunds"("id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_allocations" ADD CONSTRAINT "refund_allocations_seller_order_fk" FOREIGN KEY ("seller_order_id","order_id") REFERENCES "public"."seller_orders"("id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_processed_by_users_id_fk" FOREIGN KEY ("processed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_order_fk" FOREIGN KEY ("payment_id","order_id") REFERENCES "public"."payments"("id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_ledger_entry_id_seller_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."seller_ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_seller_id_seller_profiles_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."seller_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_payout_account_id_seller_payout_accounts_id_fk" FOREIGN KEY ("payout_account_id") REFERENCES "public"."seller_payout_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_ledger_entries" ADD CONSTRAINT "seller_ledger_entries_seller_id_seller_profiles_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."seller_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_ledger_entries" ADD CONSTRAINT "ledger_seller_order_seller_fk" FOREIGN KEY ("seller_order_id","seller_id") REFERENCES "public"."seller_orders"("id","seller_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_ledger_entries" ADD CONSTRAINT "ledger_allocation_seller_order_fk" FOREIGN KEY ("refund_allocation_id","seller_order_id") REFERENCES "public"."refund_allocations"("id","seller_order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_seller_id_seller_profiles_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."seller_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_badge_id_badges_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."badges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_awarded_by_users_id_fk" FOREIGN KEY ("awarded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_stats" ADD CONSTRAINT "user_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "addresses_user_idx" ON "addresses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "seller_locations_seller_idx" ON "seller_locations" USING btree ("seller_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_locations_one_default_uq" ON "seller_locations" USING btree ("seller_id") WHERE "seller_locations"."is_default" AND "seller_locations"."is_active";--> statement-breakpoint
CREATE INDEX "payout_accounts_seller_idx" ON "seller_payout_accounts" USING btree ("seller_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_accounts_one_default_uq" ON "seller_payout_accounts" USING btree ("seller_id") WHERE "seller_payout_accounts"."is_default" AND "seller_payout_accounts"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "attr_def_category_key_uq" ON "attribute_definitions" USING btree ("category_id","key");--> statement-breakpoint
CREATE INDEX "product_images_product_sort_idx" ON "product_images" USING btree ("product_id","sort_order");--> statement-breakpoint
CREATE INDEX "product_images_variant_idx" ON "product_images" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "variants_product_idx" ON "product_variants" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_seller_slug_uq" ON "products" USING btree ("seller_id","slug");--> statement-breakpoint
CREATE INDEX "products_category_status_idx" ON "products" USING btree ("category_id","status");--> statement-breakpoint
CREATE INDEX "products_seller_idx" ON "products" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "products_created_idx" ON "products" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "inventory_location_idx" ON "inventory" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_inventory_created_idx" ON "inventory_movements" USING btree ("inventory_id","created_at");--> statement-breakpoint
CREATE INDEX "inventory_movements_reference_idx" ON "inventory_movements" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cart_items_cart_variant_uq" ON "cart_items" USING btree ("cart_id","variant_id");--> statement-breakpoint
CREATE INDEX "favorites_product_idx" ON "favorites" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "order_items_seller_order_idx" ON "order_items" USING btree ("seller_order_id");--> statement-breakpoint
CREATE INDEX "order_items_variant_location_idx" ON "order_items" USING btree ("variant_id","location_id");--> statement-breakpoint
CREATE INDEX "orders_buyer_created_idx" ON "orders" USING btree ("buyer_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_status_due_idx" ON "orders" USING btree ("status","payment_due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_orders_order_seller_uq" ON "seller_orders" USING btree ("order_id","seller_id");--> statement-breakpoint
CREATE INDEX "seller_orders_seller_status_idx" ON "seller_orders" USING btree ("seller_id","status");--> statement-breakpoint
CREATE INDEX "seller_orders_order_idx" ON "seller_orders" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payments_order_status_idx" ON "payments" USING btree ("order_id","status");--> statement-breakpoint
CREATE INDEX "payments_method_reference_idx" ON "payments" USING btree ("method","provider_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_one_succeeded_per_order_uq" ON "payments" USING btree ("order_id") WHERE "payments"."status" = 'succeeded';--> statement-breakpoint
CREATE UNIQUE INDEX "payments_payhere_reference_uq" ON "payments" USING btree ("provider_reference") WHERE "payments"."method" = 'payhere' AND "payments"."provider_reference" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipment_events_shipment_occurred_idx" ON "shipment_events" USING btree ("shipment_id","occurred_at");--> statement-breakpoint
CREATE INDEX "shipments_seller_order_status_idx" ON "shipments" USING btree ("seller_order_id","status");--> statement-breakpoint
CREATE INDEX "shipments_tracking_idx" ON "shipments" USING btree ("tracking_number");--> statement-breakpoint
CREATE INDEX "shipments_pickup_location_idx" ON "shipments" USING btree ("pickup_location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_allocations_refund_seller_order_uq" ON "refund_allocations" USING btree ("refund_id","seller_order_id");--> statement-breakpoint
CREATE INDEX "refund_allocations_seller_order_idx" ON "refund_allocations" USING btree ("seller_order_id");--> statement-breakpoint
CREATE INDEX "refunds_order_status_idx" ON "refunds" USING btree ("order_id","status");--> statement-breakpoint
CREATE INDEX "refunds_payment_idx" ON "refunds" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "refunds_payment_status_idx" ON "refunds" USING btree ("payment_id","status");--> statement-breakpoint
CREATE INDEX "payout_items_ledger_entry_idx" ON "payout_items" USING btree ("ledger_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_items_live_entry_uq" ON "payout_items" USING btree ("ledger_entry_id") WHERE "payout_items"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "payouts_seller_status_idx" ON "payouts" USING btree ("seller_id","status");--> statement-breakpoint
CREATE INDEX "payouts_created_idx" ON "payouts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ledger_seller_created_idx" ON "seller_ledger_entries" USING btree ("seller_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_seller_order_idx" ON "seller_ledger_entries" USING btree ("seller_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_refund_allocation_uq" ON "seller_ledger_entries" USING btree ("refund_allocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_once_per_seller_order_uq" ON "seller_ledger_entries" USING btree ("seller_order_id","type") WHERE "seller_ledger_entries"."type" IN ('sale', 'commission');--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_buyer_seller_uq" ON "conversations" USING btree ("buyer_id","seller_id");--> statement-breakpoint
CREATE INDEX "conversations_seller_idx" ON "conversations" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "reviews_product_created_idx" ON "reviews" USING btree ("product_id","created_at");--> statement-breakpoint
CREATE INDEX "reviews_buyer_idx" ON "reviews" USING btree ("buyer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_badges_user_badge_uq" ON "user_badges" USING btree ("user_id","badge_id");--> statement-breakpoint
CREATE INDEX "user_badges_user_idx" ON "user_badges" USING btree ("user_id");