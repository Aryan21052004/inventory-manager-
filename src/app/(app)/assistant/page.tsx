import type { Metadata } from "next";
import { Sparkles } from "lucide-react";

import { AssistantChat } from "@/app/(app)/assistant/assistant-chat";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { assistantEnabled } from "@/lib/env";

/**
 * The inventory assistant.
 *
 * Signed-in only by virtue of living under `(app)`, whose layout redirects a
 * visitor without a session — but that guards the page, not the data. The
 * answers come from `/api/assistant`, which checks the session itself.
 *
 * Read-only by construction rather than by promise: the tools behind it are
 * lookups, and none of them can change a record. The page says so up front so
 * nobody types "cancel order 12" and waits for it to happen.
 */

export const metadata: Metadata = { title: "Assistant" };

export const dynamic = "force-dynamic";

export default function AssistantPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Inventory assistant"
        description="Ask about stock, orders, purchases, customers, suppliers and reports. It looks things up in your live data and never changes anything."
      />

      {assistantEnabled ? (
        <AssistantChat />
      ) : (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Sparkles}
              title="The assistant isn't set up yet"
              description="An administrator needs to add a Gemini API key (GEMINI_API_KEY) to the server environment and redeploy. Everything else in the application works without it."
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
