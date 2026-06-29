// packages/db/src/schema/deployment_watches.ts
import { pgTable, uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const deploymentWatches = pgTable(
  "deployment_watches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    repoUrl: text("repo_url").notNull(),
    productionUrl: text("production_url").notNull(),
    // watching | live | delayed | failed
    status: text("status").notNull().default("watching"),
    attempts: integer("attempts").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dueIdx: index("deployment_watches_due_idx").on(t.status, t.nextCheckAt),
    issueIdx: index("deployment_watches_issue_idx").on(t.issueId),
  }),
);
