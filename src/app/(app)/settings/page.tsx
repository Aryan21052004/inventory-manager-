import type { Metadata } from "next";
import { CircleDashed, Database, KeyRound, Server, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Separator } from "@/components/ui/separator";
import { authEnabled, env } from "@/lib/env";
import { checkDatabaseConnection } from "@/lib/prisma";

export const metadata: Metadata = { title: "Settings" };

// Reports live connection state, so it must never be cached at build time.
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const database = await checkDatabaseConnection();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Settings"
        description="Workspace configuration and the health of the services behind it."
      />

      <Card>
        <CardHeader>
          <CardTitle>System status</CardTitle>
          <CardDescription>
            Live check of the services this app depends on.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-0 p-0">
          <StatusRow
            icon={Database}
            label="PostgreSQL"
            detail={
              database.ok
                ? `Connected · responded in ${database.latencyMs}ms`
                : database.message
            }
            badge={
              database.ok ? (
                <Badge variant="success">Connected</Badge>
              ) : (
                <Badge variant="destructive">Unreachable</Badge>
              )
            }
          />
          <Separator />
          <StatusRow
            icon={KeyRound}
            label="Authentication (Clerk)"
            detail={
              authEnabled
                ? "Clerk keys are present. Routes are protected by the middleware."
                : "No Clerk keys found. Every route is publicly reachable until they are added."
            }
            badge={
              authEnabled ? (
                <Badge variant="success">Configured</Badge>
              ) : (
                <Badge variant="warning">Setup mode</Badge>
              )
            }
          />
          <Separator />
          <StatusRow
            icon={Server}
            label="Environment"
            detail={`Running in ${env.NODE_ENV} mode as "${env.NEXT_PUBLIC_APP_NAME}".`}
            badge={<Badge variant="muted">{env.NODE_ENV}</Badge>}
          />
        </CardContent>
      </Card>

      {(!database.ok || !authEnabled) && (
        <SetupChecklist
          databaseReady={database.ok}
          authReady={authEnabled}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="size-4 text-muted-foreground" aria-hidden />
            Users and roles
          </CardTitle>
          <CardDescription>
            Clerk owns identity; this app owns what each identity is allowed to
            do.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-3 sm:grid-cols-2">
            {[
              "Invite teammates and manage workspace members",
              "Assign roles: admin, manager, staff, viewer",
              "Restrict destructive actions to admins",
              "Sync Clerk users into the local user table via webhook",
              "Audit trail of who moved which stock",
              "Per-role navigation and page access",
            ].map((item) => (
              <li key={item} className="flex items-start gap-2.5 text-sm">
                <CircleDashed
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span className="text-muted-foreground">{item}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function StatusRow({
  icon: Icon,
  label,
  detail,
  badge,
}: {
  icon: typeof Database;
  label: string;
  detail: string;
  badge: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-4 px-6 py-4">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-0.5 break-words text-sm text-muted-foreground">
          {detail}
        </p>
      </div>
      <div className="shrink-0">{badge}</div>
    </div>
  );
}

/**
 * Only rendered while something is still unconfigured — a checklist that never
 * goes away stops being read.
 */
function SetupChecklist({
  databaseReady,
  authReady,
}: {
  databaseReady: boolean;
  authReady: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Finish setup</CardTitle>
        <CardDescription>
          Steps still outstanding on this machine.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6 text-sm">
        {!databaseReady && (
          <section className="flex flex-col gap-2">
            <h3 className="font-medium">Connect PostgreSQL</h3>
            <p className="text-muted-foreground">
              Point{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                DATABASE_URL
              </code>{" "}
              in{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                .env.local
              </code>{" "}
              at a running database, then create the schema:
            </p>
            <pre className="overflow-x-auto rounded-lg border border-border bg-muted/50 p-3 font-mono text-xs">
              npm run db:migrate
            </pre>
          </section>
        )}

        {!authReady && (
          <section className="flex flex-col gap-2">
            <h3 className="font-medium">Enable authentication</h3>
            <p className="text-muted-foreground">
              Create an application at{" "}
              <a
                href="https://dashboard.clerk.com"
                target="_blank"
                rel="noreferrer noopener"
                className="text-primary underline-offset-4 hover:underline"
              >
                dashboard.clerk.com
              </a>{" "}
              and copy both keys into{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                .env.local
              </code>
              :
            </p>
            <pre className="overflow-x-auto rounded-lg border border-border bg-muted/50 p-3 font-mono text-xs">
              {"NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_…\nCLERK_SECRET_KEY=sk_test_…"}
            </pre>
            <p className="text-muted-foreground">
              Restart the dev server afterwards — the middleware reads these at
              startup.
            </p>
          </section>
        )}
      </CardContent>
    </Card>
  );
}
