import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { CircleDashed } from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * The shape every not-yet-built section shares: a page header, whatever preview
 * the section wants to show, and an honest list of what the module will do.
 *
 * Keeping it in one component means the nine placeholder pages stay visually
 * identical and each one is short enough to read at a glance — and when a
 * module is built for real, its page simply stops using this.
 */
function ModulePlaceholder({
  title,
  description,
  icon,
  planned,
  actions,
  children,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  /** What this module will do once implemented. */
  planned: string[];
  actions?: ReactNode;
  /** Optional preview, such as an empty table showing the eventual columns. */
  children?: ReactNode;
}) {
  const Icon = icon;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={title} description={description} actions={actions} />

      {children ?? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Icon}
              title={`No ${title.toLowerCase()} yet`}
              description={`This module is scaffolded but not implemented. ${description}`}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Planned for this module</CardTitle>
          <CardDescription>
            Scoped but not yet built — tracked for an upcoming milestone.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-3 sm:grid-cols-2">
            {planned.map((item) => (
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

export { ModulePlaceholder };
